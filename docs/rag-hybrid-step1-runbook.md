# 步骤 1：全新 Milvus 2.6 隔离验证

## 范围与安全边界

仓库当前 `docker-compose.yml` 是 Milvus 2.3.3。用户已确认旧 Milvus 数据不需要迁移，因此采用**全新 2.6.24 实例与全新卷**。不把旧卷挂到新版容器，不运行 `docker compose down -v`，也不做旧版本原地升级或备份恢复演练。旧卷暂时保留，但不承担业务回滚。

本步骤的测试环境由 `docker-compose.rag-hybrid-smoke.yml` 提供：独立 Compose 项目、独立 etcd/MinIO/Milvus 命名卷，只有 Milvus gRPC 端口映射到本机 `127.0.0.1:19531`，不会使用旧实例的 `19530` 或旧卷。测试环境的 `MQ_TYPE=woodpecker` 只用于**全新实例**，不应用于原地升级旧实例。

固定版本：Milvus `2.6.24`、etcd `v3.5.25`、MinIO `milvusdb/minio:RELEASE.2024-12-18T13-15-44Z`、仓库当前安装的 Node SDK `2.6.17`。Milvus 2.6.24 发布说明列出 Node SDK 2.6.17；依赖版本参考官方升级说明及当前官方 standalone Compose。`minio/minio` 镜像仓库在本地拉取时返回拒绝访问，因此采用当前官方 Compose 所用的 `milvusdb/minio` 镜像。注意：官方 Git 标签下 Compose 文件内镜像标签可能没有同步到该标签版本，因此这里明确锁定 2.6.24。

## 1. 启动前确认

在 Docker Desktop 可用时，从仓库根目录执行：

```powershell
docker compose -f docker-compose.yml ps
docker compose -f docker-compose.yml config --volumes
docker volume ls
```

只需确认旧项目和测试项目卷名不同；不读取或修改旧卷。MySQL 的旧 `knowledge_bases.collection_name` 可能指向新实例里不存在的集合，应用切换前必须决定重建或隔离这些记录，本步骤不删除任何 MySQL 数据。

## 2. 启动独立测试实例

```powershell
docker compose -f docker-compose.rag-hybrid-smoke.yml config --quiet
docker compose -f docker-compose.rag-hybrid-smoke.yml up -d
docker compose -f docker-compose.rag-hybrid-smoke.yml ps
```

首次启动需要拉取镜像。等三个服务健康后运行：

```powershell
node scripts/rag/hybrid-smoke.mjs
```

脚本只连接 `127.0.0.1:19531`，会校验服务端 2.6.x，创建随机命名的临时 Collection；Collection 含 analyzer、BM25 Function、Dense/BM25 双索引。随后插入三条合成文本/向量，分别执行 Dense、BM25 和 RRF Hybrid Search，检查目标主键是否命中，最后清理**脚本自身创建的临时集合**。不会读写旧实例或真实业务 Collection。

停止测试环境可用 `docker compose -f docker-compose.rag-hybrid-smoke.yml down`，**不加 `-v`**，保留测试卷以便排查。删除测试卷是单独的清理决策，不属于本步骤自动动作。

## 3. 后续接入准备

下一阶段在新 Milvus 上建立正式 Hybrid Schema，并重新上传测试/业务文档；新 Sparse 向量由 BM25 Function 根据 `text` 生成。旧 Collection 不复制，旧 MySQL 知识库记录也不能直接当成新集合使用。

## 本步骤通过条件

- 隔离 Milvus 2.6.24 及依赖全部健康；脚本四项能力检查（创建/插入、Dense、BM25、Hybrid）通过。
- 测试实例使用与旧 Milvus、etcd、MinIO 完全不同的卷；旧卷没有被挂载或删除。

本步骤的隔离能力验收已通过；正式应用切换与旧 MySQL 记录处理属于后续步骤。

## 本地执行记录（2026-10-18）

- `docker compose -f docker-compose.rag-hybrid-smoke.yml config --quiet`、`node --check scripts/rag/hybrid-smoke.mjs`：通过。
- 隔离项目的 etcd、MinIO、Milvus 2.6.24 均显示 `healthy`；仅映射 `127.0.0.1:19531`。
- `node scripts/rag/hybrid-smoke.mjs`：Dense Search、BM25 Search、Hybrid Search + RRF 均通过，临时 Collection 已清理。
- 验收后已对隔离项目执行不带 `-v` 的 `down`：测试容器已停止并移除，测试卷保留。
- 旧项目 `docker compose -f docker-compose.yml ps` 为空；旧卷 `dk-agent_etcd_data`、`dk-agent_milvus_data`、`dk-agent_minio_data`、`dk-agent_mysql_data`、`dk-agent_redis_data` 仍存在，未挂载到测试项目。
- 2026-10-19 决策变更：不迁移旧 Milvus 数据。此前未做的备份恢复及数据复制不再是本计划的验收项。

参考：[Milvus 2.6 Standalone 升级指南](https://milvus.io/docs/v2.6.x/upgrade_milvus_standalone-docker.md) · [Milvus v2.6.24 发布说明](https://github.com/milvus-io/milvus/releases/tag/v2.6.24) · [官方 Standalone Compose](https://github.com/milvus-io/milvus/blob/master/deployments/docker/standalone/docker-compose.yml)
