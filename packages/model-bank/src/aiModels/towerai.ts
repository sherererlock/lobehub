import type { AIChatModelCard } from '../types/aiModel';

const toweraiChatModels: AIChatModelCard[] = [
  {
    abilities: { functionCall: true },
    contextWindowTokens: 128_000,
    description: 'GPT-5.2 via Tower AI proxy',
    displayName: 'GPT-5.2',
    enabled: true,
    id: 'gpt-5.2',
    type: 'chat',
  },
  {
    abilities: { functionCall: true },
    contextWindowTokens: 128_000,
    description: 'OpenAI o3 via Tower AI proxy',
    displayName: 'o3',
    enabled: true,
    id: 'o3',
    type: 'chat',
  },
  {
    abilities: { functionCall: true, vision: true },
    contextWindowTokens: 200_000,
    description: 'Claude Sonnet 4.6 via Tower AI proxy',
    displayName: 'Claude Sonnet 4.6',
    enabled: true,
    id: 'claude-sonnet-4-6',
    type: 'chat',
  },
  {
    abilities: { functionCall: true, vision: true },
    contextWindowTokens: 1_000_000,
    description: 'Gemini 3.0 Flash via Tower AI proxy',
    displayName: 'Gemini 3.0 Flash',
    enabled: true,
    id: 'gemini-3-flash-preview',
    type: 'chat',
  },
  {
    abilities: { functionCall: true, vision: true },
    contextWindowTokens: 1_000_000,
    description: 'Gemini 3.1 Pro Preview via Tower AI proxy',
    displayName: 'Gemini 3.1 Pro Preview',
    enabled: true,
    id: 'gemini-3.1-pro-preview',
    type: 'chat',
  },
];

export default toweraiChatModels;
