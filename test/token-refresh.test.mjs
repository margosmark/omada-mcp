import assert from 'node:assert/strict';
import test from 'node:test';
import https from 'node:https';

import { accessTokenHeader } from '../src/core.mjs';
import { OmadaClient, TOKEN_EXPIRED_CODE, isTokenExpiredError, withTokenRefresh } from '../src/omada-client.mjs';

/**
 * Token-expiry regression suite.
 *
 * Root cause being pinned down (live 2026-10-24): #token() returned the cached
 * access token unconditionally and nothing handled the controller's -44112, so
 * a process that outlived its token failed every subsequent call until it was
 * killed. Before the fix that failure was permanent; now it mints a new token
 * via client_credentials and retries exactly once.
 *
 * #send is a true JS private method, so the transport is faked at
 * https.request — the level #send actually calls. Every test here is offline.
 */

/** Records outgoing request options and replies with a scripted envelope. */
function fakeHttps(handler) {
  const original = https.request;
  const calls = [];
  https.request = (options, cb) => {
    const request = {
      on() {
        return request;
      },
      write() {
        return request;
      },
      destroy() {
        return request;
      },
      end() {
        calls.push(options);
        const { status = 200, body } = handler(options, calls.length);
        queueMicrotask(() => {
          const text = typeof body === 'string' ? body : JSON.stringify(body);
          const response = {
            statusCode: status,
            on(event, fn) {
              if (event === 'data') fn(Buffer.from(text));
              if (event === 'end') fn();
            },
          };
          cb(response);
        });
      },
    };
    return request;
  };
  return { calls, restore: () => { https.request = original; } };
}

/** Split recorded calls into the OAuth token POSTs and the data reads. */
function splitCalls(calls) {
  const token = calls.filter((c) => String(c.path).includes('/authorize/token'));
  const reads = calls.filter((c) => !String(c.path).includes('/authorize/token'));
  return { token, reads };
}

function client({ accessToken, clientId, clientSecret } = {}) {
  return new OmadaClient({
    baseUrl: 'https://omada.test:8043',
    omadacId: 'f7f57b09f72cb258cd102191102bf8d5',
    accessToken,
    clientId,
    clientSecret,
  });
}

/** The envelope shape the controller returns: errorCode plus optional result. */
const expiredBody = { errorCode: TOKEN_EXPIRED_CODE, msg: 'The access token has expired. Please re-initiate the refreshToken process to obtain the access token.' };
const okBody = { errorCode: 0, result: [{ siteId: 'home' }] };
const freshTokenBody = { errorCode: 0, result: { accessToken: 'fresh-token' } };

// --- Pure helpers ------------------------------------------------------------

test('isTokenExpiredError recognises the controller code without parsing text', () => {
  const byCode = new Error('anything');
  byCode.errorCode = TOKEN_EXPIRED_CODE;
  assert.equal(isTokenExpiredError(byCode), true);
});

test('isTokenExpiredError falls back to the envelope message text', () => {
  const byText = new Error(`GET /sites returned error ${TOKEN_EXPIRED_CODE}: The access token has expired.`);
  assert.equal(isTokenExpiredError(byText), true);
});

test('isTokenExpiredError rejects other errors, including other negative codes', () => {
  const other = new Error('GET /sites returned error -44113: something else');
  other.errorCode = -44113;
  assert.equal(isTokenExpiredError(other), false);
  assert.equal(isTokenExpiredError(new Error('Request timed out.')), false);
  assert.equal(isTokenExpiredError(null), false);
  assert.equal(isTokenExpiredError(undefined), false);
});

test('withTokenRefresh passes a successful attempt straight through', async () => {
  let refreshed = 0;
  const result = await withTokenRefresh(async () => 'ok', async () => { refreshed += 1; });
  assert.equal(result, 'ok');
  assert.equal(refreshed, 0, 'a working attempt must not trigger a refresh');
});

test('withTokenRefresh never refreshes on a non-expired error', async () => {
  let refreshed = 0;
  const boom = new Error('GET /sites returned error -44101: not found');
  boom.errorCode = -44101;
  await assert.rejects(
    () => withTokenRefresh(async () => { throw boom; }, async () => { refreshed += 1; }),
    (error) => error === boom,
    'the original error object must be propagated unchanged',
  );
  assert.equal(refreshed, 0);
});

test('withTokenRefresh refreshes once then retries on an expired token', async () => {
  let refreshed = 0;
  let attempts = 0;
  const expired = new Error(`x returned error ${TOKEN_EXPIRED_CODE}: expired`);
  expired.errorCode = TOKEN_EXPIRED_CODE;
  const result = await withTokenRefresh(
    async () => {
      attempts += 1;
      if (attempts === 1) throw expired;
      return 'recovered';
    },
    async () => { refreshed += 1; },
  );
  assert.equal(result, 'recovered');
  assert.equal(attempts, 2, 'one retry after the refresh');
  assert.equal(refreshed, 1);
});

test('withTokenRefresh gives up after one retry instead of looping', async () => {
  let refreshed = 0;
  let attempts = 0;
  const expired = new Error(`x returned error ${TOKEN_EXPIRED_CODE}: expired`);
  expired.errorCode = TOKEN_EXPIRED_CODE;
  await assert.rejects(
    () => withTokenRefresh(
      async () => {
        attempts += 1;
        throw expired;
      },
      async () => { refreshed += 1; },
    ),
    (error) => error === expired,
    'the second failure must propagate untouched',
  );
  assert.equal(refreshed, 1, 'refresh runs at most once, even when the retry also fails');
  assert.equal(attempts, 2);
});

test('withTokenRefresh surfaces a refresh failure rather than the expired token', async () => {
  const refreshError = new Error('connect ECONNREFUSED');
  await assert.rejects(
    () => withTokenRefresh(
      async () => { const e = new Error('expired'); e.errorCode = TOKEN_EXPIRED_CODE; throw e; },
      async () => { throw refreshError; },
    ),
    (error) => error === refreshError,
    'losing the network during refresh must not be reported as a token problem',
  );
});

// --- Client wiring: the path that was actually broken ------------------------

test('a stale cached token is replaced and the call retries successfully', async (t) => {
  const fake = fakeHttps((options) => {
    if (String(options.path).includes('/authorize/token')) return { body: freshTokenBody };
    // First attempt carries the stale token -> expired; after refresh -> ok.
    if (options.headers.Authorization === accessTokenHeader('fresh-token').Authorization) {
      return { body: okBody };
    }
    return { body: expiredBody };
  });
  t.after(fake.restore);

  const c = client({ accessToken: 'stale-token', clientId: 'id', clientSecret: 'secret' });
  const result = await c.request('GET', '/sites');

  assert.deepEqual(result, okBody.result, 'the retried call must return real data');
  const { token, reads } = splitCalls(fake.calls);
  assert.equal(token.length, 1, 'exactly one token mint');
  assert.equal(reads.length, 2, 'original attempt plus one retry');
  assert.equal(reads[0].headers.Authorization, accessTokenHeader('stale-token').Authorization);
  assert.equal(
    reads[1].headers.Authorization,
    accessTokenHeader('fresh-token').Authorization,
    'the retry must carry the newly minted token, not replay the expired one',
  );
});

test('a client with only a static token does not retry — it reports the expired token', async (t) => {
  const fake = fakeHttps(() => ({ body: expiredBody }));
  t.after(fake.restore);

  const c = client({ accessToken: 'stale-token' });
  await assert.rejects(() => c.request('GET', '/sites'), (error) => error.errorCode === TOKEN_EXPIRED_CODE);

  const { token, reads } = splitCalls(fake.calls);
  assert.equal(token.length, 0, 'nothing to re-mint without client credentials');
  assert.equal(reads.length, 1, 'no pointless retry when a refresh is impossible');
});

test('a non-expired controller error is reported as-is with no extra round trip', async (t) => {
  const fake = fakeHttps(() => ({ body: { errorCode: -44101, msg: 'Unknown site.' } }));
  t.after(fake.restore);

  const c = client({ accessToken: 'stale-token', clientId: 'id', clientSecret: 'secret' });
  await assert.rejects(() => c.request('GET', '/sites'), (error) => error.errorCode === -44101);

  const { token, reads } = splitCalls(fake.calls);
  assert.equal(token.length, 0, 'an unrelated failure must not trigger a token refresh');
  assert.equal(reads.length, 1);
});

test('an expired token on both attempts refreshes only once and then fails', async (t) => {
  const fake = fakeHttps((options) => {
    // The token mint succeeds; it is the reads that stay expired, which is the
    // case that proves a second refresh never happens.
    if (String(options.path).includes('/authorize/token')) return { body: freshTokenBody };
    return { body: expiredBody };
  });
  t.after(fake.restore);

  const c = client({ accessToken: 'stale-token', clientId: 'id', clientSecret: 'secret' });
  await assert.rejects(() => c.request('GET', '/sites'), (error) => error.errorCode === TOKEN_EXPIRED_CODE);

  const { token, reads } = splitCalls(fake.calls);
  assert.equal(token.length, 1, 'one refresh attempt, never a loop');
  assert.equal(reads.length, 2, 'original plus exactly one retry');
});
