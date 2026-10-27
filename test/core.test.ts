import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classify } from '../src/shared/sources';
import { adSourceName, computeAdRates } from '../src/worker/ads';
import { belongsTo, normalizePath } from '../src/worker/collect';
import { verifyStandardWebhook } from '../src/worker/lib/crypto';
import { bucketLabels, resolveRange, startOfDay, tzOffset } from '../src/worker/lib/time';
import { isBot, parseUA } from '../src/worker/lib/ua';

describe('classify', () => {
  it('maps t.co to X / social', () => {
    expect(classify({ referrerDomain: 't.co' })).toMatchObject({ source: 'X', channel: 'Organic Social' });
  });
  it('maps Google to organic search', () => {
    expect(classify({ referrerDomain: 'google.co.in' })).toMatchObject({ source: 'Google', channel: 'Organic Search' });
  });
  it('recognises AI assistants, including utm_source=chatgpt.com', () => {
    expect(classify({ referrerDomain: null, utmSource: 'chatgpt.com' })).toMatchObject({ source: 'ChatGPT', channel: 'AI' });
  });
  it('lets ref/utm tags win over the referrer', () => {
    expect(classify({ referrerDomain: 'google.com', ref: 'producthunt' })).toMatchObject({ source: 'Product Hunt' });
    expect(classify({ referrerDomain: null, ref: 'my-newsletter-42' })).toMatchObject({ source: 'my-newsletter-42', channel: 'Referral' });
  });
  it('detects paid and email by medium', () => {
    expect(classify({ referrerDomain: 'google.com', utmMedium: 'cpc' }).channel).toBe('Paid');
    expect(classify({ referrerDomain: null, utmSource: 'buttondown', utmMedium: 'email' }).channel).toBe('Email');
  });
  it('falls back to Direct', () => {
    expect(classify({ referrerDomain: null })).toMatchObject({ source: 'Direct/None', channel: 'Direct' });
  });
  it('does not confuse mail.google.com with Google search', () => {
    expect(classify({ referrerDomain: 'mail.google.com' })).toMatchObject({ source: 'Gmail', channel: 'Email' });
  });
});

describe('user agents', () => {
  it('parses common browsers', () => {
    expect(parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toEqual({ browser: 'Mobile Safari', os: 'iOS', device: 'Mobile' });
    expect(parseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0')).toEqual({ browser: 'Edge', os: 'Windows', device: 'Desktop' });
    expect(parseUA('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36').browser).toBe('Chrome');
  });
  it('flags bots', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBot('Mozilla/5.0 HeadlessChrome/120')).toBe(true);
    expect(isBot('')).toBe(true);
    expect(isBot('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129 Safari/537.36')).toBe(false);
  });
});

describe('domains and paths', () => {
  it('accepts subdomains only', () => {
    expect(belongsTo('app.shipkit.dev', 'shipkit.dev')).toBe(true);
    expect(belongsTo('www.shipkit.dev', 'shipkit.dev')).toBe(true);
    expect(belongsTo('evilshipkit.dev', 'shipkit.dev')).toBe(false);
  });
  it('normalises paths', () => {
    expect(normalizePath('/pricing/')).toBe('/pricing');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/caf%C3%A9')).toBe('/café');
  });
});

describe('time ranges', () => {
  const now = Date.UTC(2026, 9, 23, 12, 0); // 23 Oct 2026 12:00 UTC
  it('computes timezone offsets', () => {
    expect(tzOffset('Asia/Kolkata', now)).toBe(330 * 60_000);
    expect(tzOffset('UTC', now)).toBe(0);
  });
  it('starts "today" at local midnight', () => {
    const r = resolveRange({ period: 'today' }, 'Asia/Kolkata', 0, now);
    expect(r.from).toBe(Date.UTC(2026, 9, 22, 18, 30));
    expect(r.granularity).toBe('hour');
  });
  it('last 30 days covers 30 local days', () => {
    const r = resolveRange({ period: '30d' }, 'UTC', 0, now);
    expect(r.from).toBe(startOfDay(now, 'UTC') - 29 * 86_400_000);
    expect(bucketLabels(r, 0)).toHaveLength(30);
  });
  it('custom ranges include the whole last day', () => {
    const r = resolveRange({ period: 'custom', from: '2026-10-01', to: '2026-10-07' }, 'UTC', 0, now);
    expect(r.to - r.from).toBe(7 * 86_400_000);
  });
  it('weekly buckets start on Monday', () => {
    const r = resolveRange({ period: '30d', granularity: 'week' }, 'UTC', 0, now);
    for (const l of bucketLabels(r, 0)) expect(new Date(l + 'T00:00:00Z').getUTCDay()).toBe(1);
  });
});

describe('Standard Webhooks (Dodo)', () => {
  const key = Buffer.from('super-secret-key-bytes');
  const secret = 'whsec_' + key.toString('base64');
  const body = '{"type":"payment.succeeded"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = createHmac('sha256', key).update(`msg_1.${ts}.${body}`).digest('base64');
  it('accepts a valid signature (also among several)', async () => {
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body)).toBe(true);
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,old v1,${sig}` }, body)).toBe(true);
  });
  it('rejects tampering and stale timestamps', async () => {
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: `v1,${sig}` }, body + ' ')).toBe(false);
    expect(await verifyStandardWebhook(secret, { id: 'msg_1', timestamp: String(Number(ts) - 3600), signature: `v1,${sig}` }, body)).toBe(false);
  });
});

describe('ad rates', () => {
  const v = (path: string, n: number, source = 'Google') => ({ path, source, n });
  const views = [v('/a', 1000), v('/b', 1000), v('/rare', 10)];
  it('prices the whole site at earnings per human pageview', () => {
    expect(computeAdRates(2010, views)?.get('*')).toBeCloseTo(1);
  });
  it('gives busy pages their own rate and pulls quiet pages toward the site rate', () => {
    // The page report adds up to 10% more than the daily total; it's scaled down to match.
    const rates = computeAdRates(2010, views, { earnings: new Map([['/a', 1650], ['/b', 550], ['/rare', 11]]), views })!;
    expect(rates.get('/a')!).toBeGreaterThan(1.3);
    expect(rates.get('/b')!).toBeLessThan(0.6);
    expect(rates.get('/rare')!).toBeCloseTo(1, 1);
  });
  it('prices each traffic source, pooling the ones the network does not name', () => {
    const mixed = [v('/a', 1000, 'Reddit'), v('/a', 1000, 'Direct/None'), v('/a', 50, 'DuckDuckGo')];
    const rates = computeAdRates(2050, mixed, null, { earnings: new Map([['Reddit', 500], ['Direct/None', 1500], ['', 50]]), views: mixed })!;
    const worth = (s: string) => rates.get('*')! * rates.get('source:' + s)!;
    expect(worth('Reddit')).toBeCloseTo(0.55, 1);
    expect(worth('Direct/None')).toBeCloseTo(1.45, 1);
    // The day still adds up to what was paid.
    expect(1000 * worth('Reddit') + 1000 * worth('Direct/None') + 50 * worth('')).toBeCloseTo(2050);
  });
  it('does not mark a page down again for the visitors its source already explains', () => {
    const mixed = [v('/blog', 1000, 'Reddit'), v('/home', 1000, 'Direct/None')];
    const rates = computeAdRates(2000, mixed, { earnings: new Map([['/blog', 500], ['/home', 1500]]), views: mixed }, {
      earnings: new Map([['Reddit', 500], ['Direct/None', 1500]]),
      views: mixed,
    })!;
    expect(rates.get('/blog')! / rates.get('*')!).toBeGreaterThan(0.9);
    expect(rates.get('/home')! / rates.get('*')!).toBeLessThan(1.1);
  });
  it('earns nothing without pageviews to price', () => {
    expect(computeAdRates(500, [], { earnings: new Map([['/a', 500]]), views: [] })).toBeNull();
  });
  it('matches ad network source labels to Minilytics sources', () => {
    expect(['Google Search', 'Direct', 'Reddit', 'Bing', 'ChatGPT', 'Other', 'Esp'].map(adSourceName)).toEqual([
      'Google', 'Direct/None', 'Reddit', 'Bing', 'ChatGPT', '', '',
    ]);
  });
});
