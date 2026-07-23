# conductor-brain-multiproject spike 安全区

issue #93 B5 的 `scripts/dispatch-brain-task.mjs` 用这个目录当 `TaskContract.policy.allowedPaths`
的目标——独立于 #75/#80 那份既有安全区（`docs/conductor-brain-layer/spike/**`），避免两次验证的
审计痕迹混在一起（PRD §4.6/plan.md §B5）。

**不放任何真实业务代码。** 本次 B5 的验证任务是良性、自证、不需要读写任何文件的合成任务（如
`reverseString(s)`），这个目录只是契约层面"允许被改动的路径"这个字段需要一个值，不代表任务真的
会往这里写文件。coder/tester 的实际工具执行 cwd 今天不指向任何目标项目（PRD §3.1/§3.2 判定：
这条透传管线不存在，片①不做），更不会指向这个目录或 whoseorder。
