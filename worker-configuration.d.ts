interface Env {
  RUNNING_IN_DOCKER: Settings;
  DEFAULT_NUM_CTX: Settings;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  GROQ_API_KEY: string;
  HuggingFace_API_KEY: string;
  OPEN_ROUTER_API_KEY: string;
  OLLAMA_API_BASE_URL: string;
  OPENAI_LIKE_API_KEY: string;
  OPENAI_LIKE_API_BASE_URL: string;
  OPENAI_LIKE_API_MODELS: string;
  TOGETHER_API_KEY: string;
  TOGETHER_API_BASE_URL: string;
  DEEPSEEK_API_KEY: string;
  LMSTUDIO_API_BASE_URL: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  MISTRAL_API_KEY: string;
  XAI_API_KEY: string;
  PERPLEXITY_API_KEY: string;
  AWS_BEDROCK_CONFIG: string;

  // Alibaba Cloud Model Studio / DashScope (OpenAI-compatible mode).
  // These names are load-bearing beyond typing: when no .env.local is present
  // (Docker/Render/Coolify images), bindings.sh derives the list of runtime env
  // vars to forward to the server by grepping this interface. Anything missing
  // here is silently dropped, and the provider reports "Missing API Key".
  DASHSCOPE_API_KEY: string;
  DASHSCOPE_BASE_URL: string;
  DASHSCOPE_API_MODELS: string;

  // xKiro
  XKIRO_API_KEY: string;
  XKIRO_BASE_URL: string;
  XKIRO_API_MODELS: string;

  // Vercel (used by the server side deploy endpoint)
  VERCEL_TOKEN: string;
  VITE_VERCEL_ACCESS_TOKEN: string;

  // Providers that were also missing from this list
  CEREBRAS_API_KEY: string;
  FIREWORKS_API_KEY: string;
  MOONSHOT_API_KEY: string;
  ZAI_API_KEY: string;
  HYPERBOLIC_API_BASE_URL: string;
  HYPERBOLIC_API_KEY: string;
}

