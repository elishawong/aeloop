# Brain adapters

脑（Brain）是产品层的需求编译与交互层，不属于 Aeloop 执行内核。它负责把 PRD、对话和公司规则整理成 `TaskContract`，再把人工决定传给 Aeloop。

引擎只消费 brain 导出的、带版本号的 contract。Brain 的 prompt 可以独立演进，但绝不能包含凭证、客户数据或仓库机密。

内置模板：

- `personal/`：偏灵活的个人 brain profile，供 Helix 一类的用法使用。
- `company/`：偏保守的公司 brain profile，供 Verity 一类的用法使用。

这些文件是安全的默认值，不能替代部署专属的策略或机密管理。

