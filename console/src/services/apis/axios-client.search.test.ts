import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '@/test/mocks/node';
import { axiosInstance } from './axios-client';

describe('finding search empty-value compatibility', () => {
  it('retains the empty value only for GET search requests with a finding severity filter', async () => {
    let captured: URL | undefined;
    server.use(
      http.get('/api/search', ({ request }) => {
        captured = new URL(request.url);
        return HttpResponse.json({});
      }),
    );
    await axiosInstance.get('/api/search', {
      params: { value: '', severity: ['high'] },
    });
    expect(captured?.searchParams.get('value')).toBe('');
    await axiosInstance.get('/api/search', {
      params: { value: '', severity: [] },
    });
    expect(captured?.searchParams.has('value')).toBe(false);
  });
  it('preserves empty-parameter cleaning for other endpoints and methods', async () => {
    const captured: URL[] = [];
    server.use(
      http.get('/api/targets', ({ request }) => {
        captured.push(new URL(request.url));
        return HttpResponse.json({});
      }),
      http.post('/api/search', ({ request }) => {
        captured.push(new URL(request.url));
        return HttpResponse.json({});
      }),
    );
    await axiosInstance.get('/api/targets', {
      params: { value: '', severity: ['high'] },
    });
    await axiosInstance.post('/api/search', null, {
      params: { value: '', severity: ['high'] },
    });
    expect(captured.every((url) => !url.searchParams.has('value'))).toBe(true);
  });
});
