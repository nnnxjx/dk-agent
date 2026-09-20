import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type McpServerStatus = 'pending' | 'healthy' | 'unhealthy' | 'disabled';

/**
 * 阶段 3：MCP Server 配置（纯 HTTP）
 * - 按 tenantId 隔离；同一租户内 alias 唯一（工具命名空间）
 * - headers 加密后落库（见 mcp-credentials），读出即解密为明文对象
 * - 无状态复用：每次调用新建连接；configVersion 用于让旧配置失效
 */
@Entity('mcp_servers')
@Index(['tenantId', 'alias'], { unique: true })
export class McpServer {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'tenant_id' })
  tenantId: string;

  /** 管理展示名称 */
  @Column()
  name: string;

  /** 工具命名空间，租户内唯一，仅允许字母数字下划线 */
  @Column()
  alias: string;

  /** Streamable HTTP 地址 */
  @Column({ type: 'text' })
  url: string;

  /** 加密后的请求头 JSON（Authorization / X-API-Key 等），见 McpCredentialsService */
  @Column({ name: 'headers_encrypted', type: 'text', nullable: true })
  headersEncrypted: string | null;

  /** 密钥版本：轮换 MCP_CREDENTIALS_KEY 后递增写入 */
  @Column({ name: 'credentials_key_version', default: 1 })
  credentialsKeyVersion: number;

  @Column({ name: 'connection_timeout_ms', nullable: true })
  connectionTimeoutMs: number | null;

  @Column({ name: 'tool_call_timeout_ms', nullable: true })
  toolCallTimeoutMs: number | null;

  @Column({ default: true })
  enabled: boolean;

  @Column({ default: 'pending' })
  status: McpServerStatus;

  @Column({ name: 'last_connected_at', type: 'datetime', nullable: true })
  lastConnectedAt: Date | null;

  @Column({ name: 'last_checked_at', type: 'datetime', nullable: true })
  lastCheckedAt: Date | null;

  /** 脱敏后的错误摘要，禁止写入凭据原文 */
  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  /** 配置版本：URL/headers/超时变更时递增，旧连接凭此失效 */
  @Column({ name: 'config_version', default: 1 })
  configVersion: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
