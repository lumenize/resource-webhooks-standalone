// The tools and resources the conformance suite's server scenarios call by name, as its
// reference server implements them. They exist only in the conformance build.
import type { ExtraResource, ExtraTemplate, ExtraTool, ServerExtras } from '../server-role/server-role';
import { JsonRpcError } from '../json-rpc';
import { MISSING_REQUIRED_CLIENT_CAPABILITY, type CallToolResult } from '../vendor/mcp-spec/2026-07-28/schema';

// A 1×1 PNG and a WAV with no samples, the smallest valid files of each type.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const WAV = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

const NO_ARGUMENTS = { type: 'object' as const, properties: {} };

function tool(name: string, description: string, result: CallToolResult): ExtraTool {
  return { tool: { name, description, inputSchema: NO_ARGUMENTS }, call: () => result };
}

const EMBEDDED = {
  type: 'resource' as const,
  resource: { uri: 'test://embedded-resource', mimeType: 'text/plain', text: 'This is an embedded resource content.' },
};

const TOOLS: ExtraTool[] = [
  tool('test_simple_text', 'Returns simple text content', {
    resultType: 'complete',
    content: [{ type: 'text', text: 'This is a simple text response for testing.' }],
  }),
  tool('test_image_content', 'Returns image content', {
    resultType: 'complete',
    content: [{ type: 'image', data: PNG, mimeType: 'image/png' }],
  }),
  tool('test_audio_content', 'Returns audio content', {
    resultType: 'complete',
    content: [{ type: 'audio', data: WAV, mimeType: 'audio/wav' }],
  }),
  tool('test_embedded_resource', 'Returns an embedded resource', { resultType: 'complete', content: [EMBEDDED] }),
  tool('test_multiple_content_types', 'Returns text, an image and an embedded resource', {
    resultType: 'complete',
    content: [{ type: 'text', text: 'Multiple content types test:' }, { type: 'image', data: PNG, mimeType: 'image/png' }, EMBEDDED],
  }),
  tool('test_error_handling', 'Always fails, reporting the failure in its result', {
    resultType: 'complete',
    content: [{ type: 'text', text: 'This tool intentionally returns an error for testing' }],
    isError: true,
  }),
  // Sends no progress, since A answers in JSON and opens no stream to send it on.
  tool('test_tool_with_progress', 'Reports progress, which this server cannot send', {
    resultType: 'complete',
    content: [{ type: 'text', text: 'Progress tool completed' }],
  }),
];

// The suite's diagnostic tools. A asks a client for no input and sends no log message, so
// each answers plainly, except where the client lacks the capability a tool needs.
TOOLS.push(
  {
    tool: { name: 'test_missing_capability', description: 'Needs the sampling capability', inputSchema: NO_ARGUMENTS },
    call: (_args, capabilities) => {
      if (!capabilities.sampling) {
        throw new JsonRpcError(MISSING_REQUIRED_CLIENT_CAPABILITY, 'Missing required client capability: sampling', {
          requiredCapabilities: { sampling: {} },
        });
      }
      return { resultType: 'complete', content: [{ type: 'text', text: 'The client declared sampling' }] };
    },
  },
  tool('test_streaming_elicitation', 'Answers in one JSON response', {
    resultType: 'complete',
    content: [{ type: 'text', text: 'Answered without asking for input' }],
  }),
  tool('test_logging_tool', 'Answers without sending a log message', {
    resultType: 'complete',
    content: [{ type: 'text', text: 'Answered without logging' }],
  }),
);

const RESOURCES: ExtraResource[] = [
  {
    resource: { uri: 'test://static-text', name: 'static-text', mimeType: 'text/plain' },
    contents: { uri: 'test://static-text', mimeType: 'text/plain', text: 'This is the content of the static text resource.' },
  },
  {
    resource: { uri: 'test://static-binary', name: 'static-binary', mimeType: 'image/png' },
    contents: { uri: 'test://static-binary', mimeType: 'image/png', blob: PNG },
  },
];

const TEMPLATES: ExtraTemplate[] = [
  {
    template: { uriTemplate: 'test://template/{id}/data', name: 'template', mimeType: 'application/json' },
    read: (uri) => {
      const match = /^test:\/\/template\/([^/]+)\/data$/.exec(uri);
      return match ? { uri, mimeType: 'application/json', text: JSON.stringify({ id: match[1], templateTest: true }) } : undefined;
    },
  },
];

export const FIXTURES: ServerExtras = { tools: TOOLS, resources: RESOURCES, templates: TEMPLATES };
