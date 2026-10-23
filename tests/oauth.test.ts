// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { authorizeViaLoopback } from '../electron/oauth';

describe('OAuth loopback (Windows app)', () => {
  it('opens the browser with a localhost redirect and receives the code', async () => {
    let opened = '';
    let focused = false;
    const flow = authorizeViaLoopback('https://login.example/authorize?client_id=abc&state=s1', {
      open: async (url) => {
        opened = url;
      },
      onRedirect: () => (focused = true),
    });
    while (!opened) await new Promise((r) => setTimeout(r, 10));
    const redirect = new URL(opened).searchParams.get('redirect_uri')!;
    expect(redirect).toMatch(/^http:\/\/localhost:\d+$/);
    expect(new URL(opened).searchParams.get('client_id')).toBe('abc');
    const port = new URL(redirect).port;
    // e.g. the browser asking for a favicon first
    expect((await fetch(`http://127.0.0.1:${port}/favicon.ico`)).status).toBe(404);
    const res = await fetch(`http://127.0.0.1:${port}/?code=the-code&state=s1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Anmeldung abgeschlossen');
    expect(await flow.result).toEqual({ redirectUri: redirect, code: 'the-code', state: 's1', error: undefined, errorDescription: undefined });
    expect(focused).toBe(true);
    await expect(fetch(`http://127.0.0.1:${port}/?code=again`)).rejects.toThrow();
  });

  it('passes errors through and can be cancelled', async () => {
    let opened = '';
    const flow = authorizeViaLoopback('https://login.example/authorize', { open: async (url) => void (opened = url) });
    while (!opened) await new Promise((r) => setTimeout(r, 10));
    const port = new URL(new URL(opened).searchParams.get('redirect_uri')!).port;
    await fetch(`http://127.0.0.1:${port}/?error=access_denied&error_description=User%20declined`);
    expect(await flow.result).toMatchObject({ error: 'access_denied', errorDescription: 'User declined' });

    const second = authorizeViaLoopback('https://login.example/authorize', { open: async () => {} });
    second.cancel();
    expect(await second.result).toMatchObject({ error: 'cancelled' });
    expect((await authorizeViaLoopback('http://insecure.example', { open: async () => {} }).result).error).toBe('invalid_request');
  });
});
