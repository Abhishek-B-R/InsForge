import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.ROOT_ADMIN_USERNAME = 'admin';
process.env.ROOT_ADMIN_PASSWORD = 'admin-password';

const mocks = vi.hoisted(() => ({
  pool: {
    connect: vi.fn(),
    query: vi.fn(),
  },
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
  oauthProvider: { getInstance: () => ({}) },
}));

vi.mock('../../src/infra/database/database.manager.js', () => ({
  DatabaseManager: {
    getInstance: () => ({
      getPool: () => mocks.pool,
    }),
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../../src/infra/security/token.manager.js', () => ({
  TokenManager: {
    getInstance: () => ({
      generateAccessToken: vi.fn().mockReturnValue('test-access-token'),
    }),
  },
}));

vi.mock('../../src/services/auth/auth-config.service.js', () => ({
  AuthConfigService: {
    getInstance: () => ({
      getAuthConfig: vi.fn(),
      validateRedirectUrl: vi.fn(),
    }),
  },
}));

vi.mock('../../src/services/auth/auth-otp.service.js', () => ({
  AuthOTPService: {
    getInstance: () => ({
      createEmailOTP: vi.fn(),
    }),
  },
  OTPPurpose: {
    VERIFY_EMAIL: 'VERIFY_EMAIL',
    RESET_PASSWORD: 'RESET_PASSWORD',
    SIGN_IN: 'SIGN_IN',
  },
  OTPType: {
    NUMERIC_CODE: 'NUMERIC_CODE',
    HASH_TOKEN: 'HASH_TOKEN',
  },
}));

vi.mock('../../src/services/auth/oauth-config.service.js', () => ({
  OAuthConfigService: { getInstance: () => ({}) },
}));

vi.mock('../../src/services/auth/custom-oauth-config.service.js', () => ({
  CustomOAuthConfigService: { getInstance: () => ({}) },
}));

vi.mock('../../src/services/email/email.service.js', () => ({
  EmailService: { getInstance: () => ({ sendWithTemplate: vi.fn() }) },
}));

vi.mock('../../src/services/email/smtp-config.service.js', () => ({
  SmtpConfigService: { getInstance: () => ({}) },
}));

vi.mock('../../src/providers/oauth/google.provider.js', () => ({
  GoogleOAuthProvider: mocks.oauthProvider,
}));
vi.mock('../../src/providers/oauth/github.provider.js', () => ({
  GitHubOAuthProvider: mocks.oauthProvider,
}));
vi.mock('../../src/providers/oauth/discord.provider.js', () => ({
  DiscordOAuthProvider: mocks.oauthProvider,
}));
vi.mock('../../src/providers/oauth/linkedin.provider.js', () => ({
  LinkedInOAuthProvider: mocks.oauthProvider,
}));
vi.mock('../../src/providers/oauth/facebook.provider.js', () => ({
  FacebookOAuthProvider: mocks.oauthProvider,
}));
vi.mock('../../src/providers/oauth/microsoft.provider.js', () => ({
  MicrosoftOAuthProvider: mocks.oauthProvider,
}));
vi.mock('../../src/providers/oauth/x.provider.js', () => ({
  XOAuthProvider: mocks.oauthProvider,
}));
vi.mock('../../src/providers/oauth/apple.provider.js', () => ({
  AppleOAuthProvider: mocks.oauthProvider,
}));

vi.mock('../../src/infra/config/app.config.js', () => {
  const appConfig = {
    app: { jwtSecret: 'test-secret', name: 'test' },
    cloud: { projectId: null },
    auth: { rootAdminUsername: 'admin', rootAdminPassword: 'admin-password' },
  };
  return { appConfig, config: appConfig };
});

import { AuthService } from '../../src/services/auth/auth.service.js';

describe('AuthService.deleteUsers', () => {
  let authService: AuthService;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.pool.connect.mockResolvedValue(mocks.client);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (AuthService as any).instance = undefined;
    authService = AuthService.getInstance();
  });

  it('returns 0 without opening a transaction when the id list is empty', async () => {
    const deleted = await authService.deleteUsers([]);

    expect(deleted).toBe(0);
    expect(mocks.pool.connect).not.toHaveBeenCalled();
  });

  it('deletes email_otps for the users emails before deleting the users', async () => {
    mocks.client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ email: 'a@example.com' }, { email: 'b@example.com' }, { email: 'a@example.com' }],
      })
      .mockResolvedValueOnce({ rowCount: 2 }) // DELETE email_otps
      .mockResolvedValueOnce({ rowCount: 2 }) // DELETE users
      .mockResolvedValueOnce(undefined); // COMMIT

    const deleted = await authService.deleteUsers(['user-1', 'user-2']);

    expect(deleted).toBe(2);
    expect(mocks.client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(mocks.client.query).toHaveBeenNthCalledWith(
      2,
      'SELECT email FROM auth.users WHERE id IN ($1,$2)',
      ['user-1', 'user-2']
    );
    expect(mocks.client.query).toHaveBeenNthCalledWith(
      3,
      'DELETE FROM auth.email_otps WHERE email = ANY($1::text[])',
      [['a@example.com', 'b@example.com']]
    );
    expect(mocks.client.query).toHaveBeenNthCalledWith(
      4,
      'DELETE FROM auth.users WHERE id IN ($1,$2)',
      ['user-1', 'user-2']
    );
    expect(mocks.client.query).toHaveBeenNthCalledWith(5, 'COMMIT');
    expect(mocks.client.release).toHaveBeenCalledTimes(1);
  });

  it('skips the otp delete when none of the users have an email', async () => {
    mocks.client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ email: null }, { email: '' }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // DELETE users
      .mockResolvedValueOnce(undefined); // COMMIT

    const deleted = await authService.deleteUsers(['user-1']);

    expect(deleted).toBe(1);
    const sqlCalls = mocks.client.query.mock.calls.map((call) => call[0]);
    expect(sqlCalls.some((sql) => typeof sql === 'string' && sql.includes('email_otps'))).toBe(
      false
    );
    expect(mocks.client.query).toHaveBeenCalledWith(
      'DELETE FROM auth.users WHERE id IN ($1)',
      ['user-1']
    );
  });

  it('rolls back and rethrows when a step fails', async () => {
    const failure = new Error('db down');
    mocks.client.query
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rows: [{ email: 'a@example.com' }] })
      .mockRejectedValueOnce(failure) // DELETE email_otps
      .mockResolvedValueOnce(undefined); // ROLLBACK

    await expect(authService.deleteUsers(['user-1'])).rejects.toThrow('db down');
    expect(mocks.client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.client.release).toHaveBeenCalledTimes(1);
  });
});
