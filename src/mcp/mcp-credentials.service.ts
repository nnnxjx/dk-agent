import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto';

/**
 * 阶段 3：MCP 凭据加解密（AES-256-GCM）
 * - 密钥只来自 MCP_CREDENTIALS_KEY（未设置时用 MCP_CREDENTIALS_PASSWORD 派生，开发兜底仅用于本地联调）
 * - 落库格式：v<keyVersion>:<ivHex>:<authTagHex>:<cipherHex>
 * - 解密失败直接抛错，不返回半截明文
 */
@Injectable()
export class McpCredentialsService {
  private readonly keyVersion = Number(
    process.env.MCP_CREDENTIALS_KEY_VERSION || 1,
  );

  getKeyVersion(): number {
    return this.keyVersion;
  }

  encryptObject(value: Record<string, string> | undefined): string | null {
    if (!value || Object.keys(value).length === 0) return null;
    const key = this.resolveKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const plaintext = JSON.stringify(value);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return `v${this.keyVersion}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decryptObject(
    payload: string | null | undefined,
  ): Record<string, string> | undefined {
    if (!payload) return undefined;
    const parts = payload.split(':');
    if (parts.length !== 4 || !parts[0].startsWith('v')) {
      throw new Error('Invalid MCP credentials payload');
    }
    const key = this.resolveKey();
    const iv = Buffer.from(parts[1], 'hex');
    const authTag = Buffer.from(parts[2], 'hex');
    const encrypted = Buffer.from(parts[3], 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
    const parsed: unknown = JSON.parse(plaintext);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid MCP credentials content');
    }
    return parsed as Record<string, string>;
  }

  /** 脱敏展示：只返回是否配置，不回显任何值 */
  maskHeaders(headers: Record<string, string> | undefined): {
    configured: boolean;
    keys: string[];
  } {
    if (!headers || Object.keys(headers).length === 0)
      return { configured: false, keys: [] };
    return { configured: true, keys: Object.keys(headers) };
  }

  private resolveKey(): Buffer {
    const raw = process.env.MCP_CREDENTIALS_KEY;
    if (raw) {
      const key = Buffer.from(raw, 'hex');
      if (key.length !== 32) {
        throw new Error('MCP_CREDENTIALS_KEY must be 64 hex chars (32 bytes)');
      }
      return key;
    }
    // 开发兜底：仅本地联调使用，生产必须设置 MCP_CREDENTIALS_KEY
    if (process.env.NODE_ENV === 'production') {
      throw new Error('MCP_CREDENTIALS_KEY is required in production');
    }
    const password =
      process.env.MCP_CREDENTIALS_PASSWORD || 'dev-only-mcp-credentials';
    return scryptSync(password, 'nest-agent-mcp', 32);
  }
}
