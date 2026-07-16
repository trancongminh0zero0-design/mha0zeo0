import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';

export const GEMINI_CHAT_MODEL = 'gemini-3.1-flash-lite';
const KEY_COOLDOWN_MS = 5 * 60 * 1000;

export type GeminiChatContent = {
  role: string;
  parts: Array<{ text: string }>;
};

interface KeySlot {
  key: string;
  label: string;
  cooldownUntil: number;
}

let keySlots: KeySlot[] = [];
let roundRobinIndex = 0;

function stripQuotes(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

export function loadGeminiApiKeys(): string[] {
  const keys: string[] = [];

  const listEnv = process.env.GEMINI_API_KEYS;
  if (listEnv) {
    for (const part of listEnv.split(/[\n,;|]+/)) {
      const key = stripQuotes(part);
      if (key) keys.push(key);
    }
  }

  const single = process.env.GEMINI_API_KEY;
  if (single) {
    const key = stripQuotes(single);
    if (key && !keys.includes(key)) keys.unshift(key);
  }

  const keysFile = path.join(process.cwd(), 'data', 'gemini-keys.txt');
  if (fs.existsSync(keysFile)) {
    for (const line of fs.readFileSync(keysFile, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const key = stripQuotes(trimmed);
      if (key && !keys.includes(key)) keys.push(key);
    }
  }

  return [...new Set(keys)];
}

function ensureKeyPool() {
  if (keySlots.length > 0) return;
  const keys = loadGeminiApiKeys();
  keySlots = keys.map((key, index) => ({
    key,
    label: `gemini-${index + 1}`,
    cooldownUntil: 0,
  }));
  if (keySlots.length > 0) {
    console.log(`[gemini] Loaded ${keySlots.length} API key(s) for rotation`);
  }
}

function isRetryableGeminiError(error: unknown): boolean {
  const err = error as { status?: number; message?: string };
  const message = String(err?.message || error || '').toLowerCase();
  const status = err?.status;

  if (status === 429) return true;
  if (
    message.includes('quota') ||
    message.includes('rate limit') ||
    message.includes('resource_exhausted') ||
    message.includes('exceeded your current quota') ||
    message.includes('too many requests')
  ) {
    return true;
  }
  if (
    message.includes('api key not valid') ||
    message.includes('api_key_invalid') ||
    message.includes('invalid authentication credentials')
  ) {
    return true;
  }
  return false;
}

function buildTryOrder(now: number): number[] {
  const available: number[] = [];
  const cooled: number[] = [];
  for (let offset = 0; offset < keySlots.length; offset++) {
    const idx = (roundRobinIndex + offset) % keySlots.length;
    if (keySlots[idx].cooldownUntil <= now) available.push(idx);
    else cooled.push(idx);
  }
  return [...available, ...cooled];
}

function maskKey(key: string): string {
  if (key.length <= 10) return '***';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

export async function generateGeminiChatReply(
  contents: GeminiChatContent[],
  config?: { temperature?: number; topP?: number }
): Promise<string | null> {
  ensureKeyPool();
  if (keySlots.length === 0) return null;

  const now = Date.now();
  const tryOrder = buildTryOrder(now);
  let lastError: unknown;

  for (const idx of tryOrder) {
    const slot = keySlots[idx];
    try {
      const client = new GoogleGenAI({
        apiKey: slot.key,
        httpOptions: {
          headers: { 'User-Agent': 'aistudio-build' },
        },
      });

      const response = await client.models.generateContent({
        model: GEMINI_CHAT_MODEL,
        contents,
        config: {
          temperature: config?.temperature ?? 0.7,
          topP: config?.topP ?? 0.9,
        },
      });

      roundRobinIndex = (idx + 1) % keySlots.length;
      slot.cooldownUntil = 0;
      return response.text ?? null;
    } catch (error) {
      lastError = error;
      if (isRetryableGeminiError(error)) {
        slot.cooldownUntil = Date.now() + KEY_COOLDOWN_MS;
        console.warn(
          `[gemini] ${slot.label} (${maskKey(slot.key)}) unavailable — rotating to next key`
        );
        continue;
      }
      throw error;
    }
  }

  console.error('[gemini] All keys failed:', lastError);
  return null;
}

export function getGeminiKeyPoolStatus() {
  ensureKeyPool();
  const now = Date.now();
  return {
    total: keySlots.length,
    active: keySlots.filter((s) => s.cooldownUntil <= now).length,
    keys: keySlots.map((s) => ({
      label: s.label,
      masked: maskKey(s.key),
      active: s.cooldownUntil <= now,
      cooldownSec: s.cooldownUntil > now ? Math.ceil((s.cooldownUntil - now) / 1000) : 0,
    })),
  };
}
