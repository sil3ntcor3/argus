import { jsonSchema, streamText, tool } from 'ai';
import { LLMProvider } from './enums/agent.enums';
import {
  getLLMProviderConfig,
  getReasoningProviderOptions,
} from './llm-provider-supported';

afterEach(() => jest.restoreAllMocks());

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

it.each([undefined, 'https://jp.api.openai.com/v1/'])(
  'streams native OpenAI reasoning with tools through Responses without storing state (%s)',
  async (baseURL) => {
    const env = { ...process.env };
    if (baseURL) env.OPENAI_BASE_URL = baseURL;
    else delete env.OPENAI_BASE_URL;
    const endpoint = (baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '') + '/responses';
    jest.replaceProperty(process, 'env', env);
    const model = 'gpt-5';
    const item = { type: 'message', id: 'msg_test' };
    const chunks = [
      { type: 'response.created', response: { id: 'resp_test', created_at: 1, model } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_text.delta', item_id: item.id, delta: 'Test response' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation((url) =>
      Promise.resolve(
        requestUrl(url) === endpoint
          ? new Response(chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n').join(''), {
              headers: { 'content-type': 'text/event-stream' },
            })
          : new Response('{"error":{"message":"unexpected endpoint"}}', {
              status: 400,
              headers: { 'content-type': 'application/json' },
            }),
      ),
    );
    const config = getLLMProviderConfig(LLMProvider.OPENAI)!;
    const result = streamText({
      model: config.handler('fixture-key', model),
      prompt: 'Check the local test fixture',
      providerOptions: getReasoningProviderOptions(LLMProvider.OPENAI),
      tools: {
        list_findings: tool({
          inputSchema: jsonSchema({
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          }),
        }),
      },
      maxRetries: 0,
    });

    await expect(result.text).resolves.toBe('Test response');
    const [url, request] = fetchMock.mock.calls[0];
    expect(requestUrl(url)).toBe(endpoint);
    const body = request?.body;
    if (typeof body !== 'string') throw new Error('Expected a JSON request body');
    const payload: unknown = JSON.parse(body);
    expect(payload).not.toHaveProperty('reasoning.summary');
    expect(payload).toMatchObject({
      model,
      store: false,
      include: expect.arrayContaining(['reasoning.encrypted_content']),
      reasoning: { effort: 'high' },
      tools: [expect.objectContaining({ type: 'function', name: 'list_findings' })],
      stream: true,
    });
  },
);

it('keeps a deployment proxy on Chat Completions', () => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    OPENAI_BASE_URL: 'https://proxy.test/v1',
  });
  const config = getLLMProviderConfig(LLMProvider.OPENAI)!;
  expect(config.handler('fixture-key', 'gpt-5')).toHaveProperty('provider', 'openai.chat');
});
