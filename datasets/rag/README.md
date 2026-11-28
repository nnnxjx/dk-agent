# RAG 数据集

本目录保存固定语料、问题、参考答案与证据标签。运行时租户、知识库 ID、Chunk 绑定及指标报告留在 reports/rag-baseline，不复制到这里。

| 数据集 | 用途 | 规模与划分 |
| --- | --- | --- |
| [single-kb/v1](single-kb/v1/README.md) | 原步骤一、二的小规模单库题库 | 40 题；开发 30、测试 10，含有答案与无答案题 |
| [cross-kb-synthetic/v1](cross-kb-synthetic/v1/README.md) | 原步骤三合成干扰、组合、去重、故障与隔离 | 7 个场景，不作为扩充题库的保留测试集 |
| [project-docs/v1](project-docs/v1/README.md) | 当前真实项目文档问答，单库与跨库共用 | 107 道有答案题；开发 81、保留测试 26 |

每个版本内的 corpus、manifest、题目和评分规则一起使用。不能把当前检索 TopK 当作标准证据；题库和答案不上传到被测知识库。project-docs/v1 的 labels 尚未独立人工审核，保留测试题未运行。

2026-11-28 仅调整目录及说明链接，冻结原文、题目 ID、划分、原始 JSON/JSONL 字节及历史运行报告均保持不变。manifest 中原仓库路径和报告中的历史路径属于溯源信息，不因归档重写。

[评测计划与结果](../../docs/rag-evaluation/README.md)
