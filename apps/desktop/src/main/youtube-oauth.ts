/**
 * Google OAuth 2.0 for the "Publish to YouTube" uploader. Uses the installed-app
 * loopback flow (RFC 8252) with PKCE: consent opens in the user's real system
 * browser (Google blocks logins inside embedded Electron windows), the redirect
 * lands on a throwaway 127.0.0.1 server we spin up per attempt, and the returned
 * code is exchanged for a refresh token stored encrypted in settings.
 *
 * Credentials are bring-your-own (a Google Cloud "Desktop app" client), matching
 * how the app already handles AI / transcription / S3 keys - nothing secret is
 * baked into the distributed binary.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { shell } from 'electron';
import type { Settings } from '@shared/types';
import { getSettings, getSecret, setSettings } from './settings';
import { buildAuthUrl, parseLoopbackCallback, pkcePair, randomToken, YT_TOKEN_ENDPOINT } from './youtube-core';
import { log } from './logger';

/** In-memory access-token cache; the refresh token is the durable credential. */
let accessCache: { token: string; expiresAt: number } | null = null;

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type: string;
}

/** True once a refresh token is stored (i.e. the user has connected an account). */
export function isConnected(): boolean {
  return getSecret('youtube.refreshToken').trim().length > 0;
}

function requireClient(): { clientId: string; clientSecret: string } {
  const clientId = getSettings().youtube.clientId.trim();
  const clientSecret = getSecret('youtube.clientSecret').trim();
  if (!clientId || !clientSecret) {
    throw new Error('Add your Google OAuth client ID and secret in Settings › YouTube first.');
  }
  return { clientId, clientSecret };
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(YT_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text) as { error?: string; error_description?: string };
      msg = j.error_description || j.error || text;
    } catch {
      /* keep raw text */
    }
    throw new Error(`YouTube sign-in failed: ${msg}`);
  }
  return JSON.parse(text) as TokenResponse;
}

/**
 * Listen on an ephemeral 127.0.0.1 port, invoke `open(port)` to send the user to
 * consent, and resolve with the authorization code once the browser redirects
 * back. Rejects on denial, a state mismatch (CSRF guard) or a 3-minute timeout.
 */
function runLoopback(
  open: (redirectUri: string) => void,
  expectedState: string
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = '';
    const server = http.createServer((req, res) => {
      const parsed = parseLoopbackCallback(req.url ?? '');
      // Browsers also hit /favicon.ico etc.; ignore anything without our params.
      if (!parsed.code && !parsed.error) {
        res.writeHead(204);
        res.end();
        return;
      }
      const finish = (heading: string, body: string): void => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Open Loom</title>` +
            `<body style="font:16px -apple-system,system-ui,sans-serif;max-width:32rem;margin:20vh auto;text-align:center;color:#1a1a1a">` +
            `<h2 style="color:#635BFF">${heading}</h2><p>${body}</p></body>`
        );
        server.close();
        clearTimeout(timer);
      };
      if (parsed.error) {
        finish('Authorisation cancelled', 'You can close this tab and return to Open Loom.');
        reject(new Error(`YouTube authorisation was cancelled (${parsed.error}).`));
        return;
      }
      if (parsed.state !== expectedState) {
        finish('Security check failed', 'Please close this tab and try connecting again.');
        reject(new Error('YouTube authorisation failed a security check. Please try again.'));
        return;
      }
      finish('Connected', 'You can close this tab and return to Open Loom.');
      resolve({ code: parsed.code!, redirectUri });
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error('YouTube authorisation timed out. Please try again.'));
    }, 180_000);

    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      redirectUri = `http://127.0.0.1:${port}`;
      open(redirectUri);
    });
  });
}

/** Run the consent flow and persist the refresh token. Returns the new state. */
export async function connect(): Promise<{ connected: boolean }> {
  const { clientId, clientSecret } = requireClient();
  const { verifier, challenge } = pkcePair();
  const state = randomToken(16);

  const { code, redirectUri } = await runLoopback((uri) => {
    void shell.openExternal(buildAuthUrl({ clientId, redirectUri: uri, challenge, state }));
  }, state);

  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token. Disconnect and connect again.');
  }
  // Deep-merged + encrypted by the settings layer; clientId/secret untouched.
  setSettings({ youtube: { refreshToken: tokens.refresh_token } } as Partial<Settings>);
  accessCache = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 };
  log.info('youtube: account connected');
  return { connected: true };
}

/** A valid access token, refreshing via the stored refresh token when needed. */
export async function getAccessToken(): Promise<string> {
  if (accessCache && accessCache.expiresAt > Date.now()) return accessCache.token;
  const refreshToken = getSecret('youtube.refreshToken').trim();
  if (!refreshToken) throw new Error('Connect your YouTube account in Settings › YouTube first.');
  const { clientId, clientSecret } = requireClient();
  const tokens = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  accessCache = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 };
  return tokens.access_token;
}

/** Forget the stored tokens (does not revoke server-side). */
export function disconnect(): { connected: boolean } {
  accessCache = null;
  setSettings({ youtube: { refreshToken: '' } } as Partial<Settings>);
  log.info('youtube: account disconnected');
  return { connected: false };
}
