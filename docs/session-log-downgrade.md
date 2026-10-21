# 会话日志与运行时降级

一句话：DSH 的会话日志只增不减，**写它的运行时比读它的新，旧版就打不开**。Mareo 现在在启动时拦住这种降级，在发布时禁止内置 DSH 回退，并留了一个带备份与校验的恢复工具。

## 1. 症状

打开历史会话时，界面报（后面跟着 `（gateway/internal）`）：

```text
历史加载失败：failed to observe session "session-…": session "session-…" contains event type
"job/registered" (seq 22385) unknown to this harness and not marked ignorable;
refusing to interpret the log — it was likely written by a newer harness
(raw log: …/session.v4.jsonl.zstd)
```

会话列表里的其余会话正常，只有被"更新运行时"写过的那些打不开。

## 2. 根因

- 会话写在 `session.v4.jsonl.zstd` 里：多帧 Zstandard，按批追加，seq 连续。
- 事件词汇**只增不减**。例如 DSH 0.2.1-rc.2 新增 `job/registered`、`job/settled`（任务生命周期）。
- 读取时是 **fail-closed**：遇到"本运行时不认识、且写入方没有标 `ignorable: true`"的事件类型，就整份拒读（跳过未知事件可能重建出语义错误的会话），见 `@deepseek-ai/dsh-session-persistence` 的 `validateStoredEvents`。
- 所以这不是日志损坏：帧完整、seq 连续、事件都在，只是当前运行时读不懂其中的新类型。

## 3. 什么时候会撞上

1. **团队自己**：`npm start` 的 dev 构建与发行版共用同一个 `~/Library/Application Support/Mareo`（有意为之，方便用真实历史调试）；用 dev 跑过之后再开旧发行版，就会看到上面的报错。
2. **用户回滚**：装回旧版（手动装旧 dmg、或更新链回退）后，最近写过的会话全部打不开。
3. **发版回退**：某次发布把 `runtime/package.json` 的 DSH 钉版改低了。

## 4. 现在的三层保护

### 4.1 启动降级守卫

- `src/harness-stamp.ts` 在 `userData` 下维护 `harness.json`：`{ appVersion, dshVersion }`，语义是"碰过这份本地数据的最新运行时"，两个字段各自**只升不降**——降级启动不会抹掉记录，于是提醒会一直持续到升级为止。
- `src/main.ts` 在远程最低版本闸门（`passesMinimumVersion`）之后、登录与 DSH 启动之前比较：当前内置 DSH 比记录旧就弹窗，写明双方版本、说明较新的会话会打不开，并要求安装对应版本。
- 判定只看 **DSH 钉版**：真正决定日志能否读的是 DSH，不是 Mareo 的版本号；同 DSH 的旧 Mareo 不拦。
- 已打包默认「退出」，dev 默认「继续」——开发者在旧分支上是自己的选择，发行包走错了则不应该启动。
- 没读到时（首次运行、运行时缺失、`harness.json` 损坏）一律放行：守卫不能把人锁在门外。

### 4.2 发版禁止 DSH 回退

`scripts/release.mjs` 打 tag 前比对**上一个 tag** 的 `runtime/package.json` 与工作区里的钉版；回退即拒绝发布，确实要回退必须显式加 `--allow-dsh-downgrade`。计划输出里会打印 `内置 DSH：0.2.1-rc.2 -> 0.2.2-rc.1` 这类一行，方便复核。

### 4.3 恢复工具

```sh
node scripts/unstick-session.mjs "<会话目录>/session.v4.jsonl.zstd" \
  --runtime "/Applications/Mareo.app/Contents/Resources/dsh-runtime"
```

把"当前运行时不认识"的事件信封补上 `ignorable: true`，让旧运行时能读：

- 只改信封，不动 `seq`/`time`/`data`；已知事件一个字节都不动。
- 逐帧校验：帧数不变、每帧明文与"原帧 + 目标改写"完全一致、seq 连续、改完后每个事件要么认识要么 ignorable。
- 先写 `<文件>.patched` 并校验通过，才备份成 `<文件>.bak-<时间戳>` 再原子替换；文件权限沿用原文件。
- 没有需要改的就什么都不做（可重复执行）。读不懂的日志直接拒绝，不猜。
- `--runtime` 指向哪个运行时，就以哪个运行时的词汇为准（默认 `.staging/dsh-runtime`）。

⚠️ 它只负责"让旧运行时能读"，**不判断忽略这些事件是否会改变会话含义**。像 `job/*` 这种任务生命周期记录，旧版本来也不显示，忽略是安全的；换成别的事件类型，需要人先判断。

## 5. 2026-10-21 的实例

- 会话 `session-afc9bae8`（本仓库的开发会话）：seq 0–22384 由旧运行时写，21:15 之后由 dev 构建（Mareo 0.2.2 / DSH 0.2.1-rc.2）写入，含 78 条 job 事件；随后在已安装的 Mareo 0.2.1（DSH 0.2.0-rc.2）里打开，被拒读。
- 核实：3329 帧全部解码、seq 0–22795 连续无缺口、78 条未知类型只有 `job/registered`(40) 与 `job/settled`(38)。
- 处理：备份后补 `ignorable`（当时手工脚本，现在固化成 4.3 的工具），重开后正常追加。
- 结论：日志本身完好，是版本错配。

## 6. 维护提醒

- 不要发布"内置 DSH 比上一版旧"的构建；`release.mjs` 会拦，绕过它要留理由。
- dev 构建和发行版共用同一份本地数据是设计选择，代价就是第 4 节这套守卫。
- 用户报"历史加载失败 + 提到 newer harness"时，先问版本（`Mareo 关于`），再看是不是降级，最后才考虑用 4.3 修日志。
