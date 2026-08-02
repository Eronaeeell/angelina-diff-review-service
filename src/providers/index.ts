import { ProviderName } from "../types";
import { Provider } from "./types";
import { mockProvider } from "./mock";
import { llmProvider } from "./llm";

const providers: Record<ProviderName, Provider> = {
  mock: mockProvider,
  llm: llmProvider,
};

export function getProvider(name: ProviderName): Provider {
  return providers[name];
}
