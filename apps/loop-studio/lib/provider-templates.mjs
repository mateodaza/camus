// Slice C provider templates. These are copyable declaration starters, never
// executable configuration and never qualification evidence. They deliberately
// contain env-var NAMES and replace-me placeholders only: no credential value,
// lineage.source, receipt, runtime port, or resolved tunnel state can originate
// here. The operator still edits and saves local models.json explicitly, then
// qualifies each exact seat/backend/model/connection tuple.

const replace = (value) => `<replace:${value}>`;

const hosted = ({ id, label, provider, connection, baseUrl, apiKeyEnv, model,
  trainingOrg, modelFamily, inferenceOperator, docsUrl, note = null }) => ({
  id,
  label,
  availability: 'available',
  transport: 'direct_https',
  protocol: 'chat_completions',
  docsUrl,
  note,
  connection: {
    name: connection,
    value: { kind: 'direct_https', baseUrl, why: replace('why-this-endpoint') },
  },
  backend: {
    name: id,
    value: {
      kind: 'openai_compat',
      provider,
      connection,
      protocol: 'chat_completions',
      trainingOrg,
      modelFamily,
      derivedFrom: null,
      inferenceOperator,
      auth: { kind: 'env', envVar: apiKeyEnv },
      models: [model],
      seats: ['maker', 'reviewer'],
      why: replace('why-this-model'),
    },
  },
});

const local = ({ id, label, port, model, docsUrl, note = null }) => ({
  id,
  label,
  availability: 'available',
  transport: 'loopback',
  protocol: 'chat_completions',
  docsUrl,
  note,
  connection: {
    name: id,
    value: { kind: 'loopback', port, basePath: '/v1', why: replace('why-this-local-server') },
  },
  backend: {
    name: id,
    value: {
      kind: 'openai_compat',
      provider: 'self_hosted',
      connection: id,
      protocol: 'chat_completions',
      trainingOrg: replace('training-organization'),
      modelFamily: replace('model-family'),
      derivedFrom: null,
      inferenceOperator: 'self_hosted',
      auth: { kind: 'none' },
      models: [model],
      seats: ['maker', 'reviewer'],
      why: replace('why-this-model'),
    },
  },
});

const TEMPLATES = Object.freeze([
  hosted({
    id: 'xai', label: 'xAI · Grok', provider: 'xai', connection: 'xai',
    baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY', model: 'grok-4.6',
    trainingOrg: 'xai', modelFamily: 'grok', inferenceOperator: 'xai',
    docsUrl: 'https://docs.x.ai/docs/api-reference',
  }),
  hosted({
    id: 'moonshot_intl', label: 'Moonshot · Kimi (international)', provider: 'moonshot', connection: 'moonshot_intl',
    baseUrl: 'https://api.moonshot.ai/v1', apiKeyEnv: 'MOONSHOT_API_KEY', model: 'kimi-k3',
    trainingOrg: 'moonshot', modelFamily: 'kimi', inferenceOperator: 'moonshot',
    docsUrl: 'https://platform.kimi.ai/docs',
  }),
  hosted({
    id: 'moonshot_cn', label: 'Moonshot · Kimi (China)', provider: 'moonshot', connection: 'moonshot_cn',
    baseUrl: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY', model: 'kimi-k3',
    trainingOrg: 'moonshot', modelFamily: 'kimi', inferenceOperator: 'moonshot',
    docsUrl: 'https://platform.kimi.com/docs',
  }),
  hosted({
    id: 'dashscope', label: 'Alibaba Cloud · DashScope', provider: 'dashscope', connection: 'dashscope',
    // Region/workspace endpoints differ. A placeholder is safer than freezing a
    // regional guess; the docs link is part of the template.
    baseUrl: 'https://<replace:your-dashscope-endpoint>/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY', model: 'qwen3-coder-plus',
    trainingOrg: 'alibaba', modelFamily: 'qwen', inferenceOperator: 'dashscope',
    docsUrl: 'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope',
    note: 'Replace the endpoint with the exact regional/workspace URL from DashScope.',
  }),
  local({ id: 'ollama', label: 'Ollama · local', port: 11434, model: replace('ollama-model'), docsUrl: 'https://docs.ollama.com/api/openai-compatibility' }),
  local({ id: 'lm_studio', label: 'LM Studio · local', port: 1234, model: replace('lm-studio-model'), docsUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai' }),
  local({ id: 'llama_cpp', label: 'llama.cpp · local', port: 8080, model: replace('served-model'), docsUrl: 'https://github.com/ggml-org/llama.cpp/tree/master/tools/server' }),
  local({ id: 'vllm', label: 'vLLM · local', port: 8000, model: replace('served-model-name'), docsUrl: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server/' , note: 'Switch auth.kind to env and name an env var if this server requires a bearer key.' }),
  {
    id: 'private_ssh',
    label: 'Private server over SSH',
    availability: 'available',
    transport: 'ssh_tunnel',
    protocol: 'chat_completions',
    docsUrl: 'https://github.com/mateodaza/camus/blob/main/docs/OPEN-MODEL-SEATS-RFC.md#8-managed-ssh-tunnel',
    note: 'The alias must already work in ~/.ssh/config. Camus forwards to remote loopback only; it never runs a remote command or copies files.',
    connection: {
      name: 'private_gpu',
      value: {
        kind: 'ssh_tunnel',
        sshHostAlias: replace('ssh-config-alias'),
        remoteAddress: '127.0.0.1',
        remotePort: 11434,
        basePath: '/v1',
        why: replace('why-this-private-server'),
      },
    },
    backend: {
      name: 'private_model',
      value: {
        kind: 'openai_compat',
        provider: 'self_hosted',
        connection: 'private_gpu',
        protocol: 'chat_completions',
        trainingOrg: replace('training-organization'),
        modelFamily: replace('model-family'),
        derivedFrom: null,
        inferenceOperator: 'self_hosted',
        auth: { kind: 'none' },
        models: [replace('served-model-name')],
        seats: ['maker', 'reviewer'],
        why: replace('why-this-model'),
      },
    },
  },
  hosted({
    id: 'custom_openai_compat', label: 'Custom OpenAI-compatible HTTPS server', provider: 'custom', connection: 'custom_https',
    baseUrl: 'https://<replace:provider-host>/v1', apiKeyEnv: 'OPENAI_COMPAT_API_KEY', model: replace('model-id'),
    trainingOrg: replace('training-organization'), modelFamily: replace('model-family'), inferenceOperator: replace('inference-operator'),
    docsUrl: 'https://github.com/mateodaza/camus/blob/main/docs/MULTI-MODEL-SEATS.md',
    note: 'Declare origin and operator facts explicitly; the template grants no trust tier.',
  }),
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function providerTemplates() {
  return clone(TEMPLATES);
}

export const plannedProtocols = Object.freeze([
  Object.freeze({ id: 'responses', label: 'OpenAI Responses', availability: 'planned', selectable: false }),
]);
