// 理由のメモ（real_note）の長い文を LLM（Groq の無料枠、OpenAI 互換の chat completions）で短く要約して DB に残す。
// 鍵は中央 Keychain（service=GROQ_API_KEY / account=shared）から都度読む。環境変数に入れない・ログに出さない。
// 鍵が無い・失敗・タイムアウトは警告 1 行で続ける（daily を止めない）。一度埋まった summary は作り直さない。

import { execFileSync } from 'node:child_process';
import type { PrismaClient } from '@/generated/prisma/client';

/** Groq の本番モデル（https://console.groq.com/docs/models の Production Models、2026-11-11 確認）。変えるときはここだけ */
export const GROQ_MODEL = 'openai/gpt-oss-120b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
/** これより長い文だけ要約する（文字数は 1 文字 = 1 コードポイント） */
export const SUMMARY_MIN_CHARS = 80;
export const SUMMARY_MAX_CHARS = 60;
export const SUMMARY_TIMEOUT_MS = 10_000;

export type Summarizer = (text: string) => Promise<string>;

const chars = (s: string) => [...s].length;

/** 要約する対象（純粋関数）: 文が SUMMARY_MIN_CHARS 文字を超え、summary がまだ空のもの */
export function pickNotesToSummarize<T extends { text: string; summary: string | null }>(notes: T[]): T[] {
  return notes.filter((n) => chars(n.text) > SUMMARY_MIN_CHARS && !n.summary?.trim());
}

/** Keychain から Groq の鍵を読む。無ければ null（値はどこにも出さない） */
export function readGroqKey(): string | null {
  try {
    const k = execFileSync('/usr/bin/security', ['find-generic-password', '-s', 'GROQ_API_KEY', '-a', 'shared', '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return k || null;
  } catch {
    return null;
  }
}

export function groqSummarizer(apiKey: string): Summarizer {
  return async (text) => {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: 'system',
            content: `次の文は株のデイトレードで本人が注文の理由を音声入力したもの。言い直しや言い淀みを除き、判断の根拠が分かるように日本語${SUMMARY_MAX_CHARS}文字以内で要約する。要約の文だけを返す。`,
          },
          { role: 'user', content: text },
        ],
        temperature: 0.2,
        // gpt-oss は推論の分もトークンを使うので上限に余裕を持たせ、推論は短く・応答に含めない
        max_completion_tokens: 1024,
        reasoning_effort: 'low',
        include_reasoning: false,
      }),
      signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
    const out = j.choices?.[0]?.message?.content?.trim();
    if (!out) throw new Error('応答が空');
    return out;
  };
}

/**
 * 対象のメモを要約して保存する。getSummarizer は対象があるときだけ呼ぶ（鍵を読むのは要る時だけ）。null（鍵が無い）なら何もせず警告を返す。
 * 失敗したらそこで止める（同じ原因で全件失敗するので、警告は 1 行だけ）。
 */
export async function summarizeNotes(
  db: PrismaClient,
  getSummarizer: () => Summarizer | null,
): Promise<{ targets: number; summarized: number; warning: string | null }> {
  const targets = pickNotesToSummarize(await db.realNote.findMany({ select: { id: true, text: true, summary: true }, orderBy: [{ ts: 'asc' }, { id: 'asc' }] }));
  if (targets.length === 0) return { targets: 0, summarized: 0, warning: null };
  const summarize = getSummarizer();
  if (!summarize) return { targets: targets.length, summarized: 0, warning: 'Groq の鍵が Keychain に無いので要約しない' };
  let summarized = 0;
  for (const n of targets) {
    let s: string;
    try {
      s = (await summarize(n.text)).trim();
    } catch (e) {
      const err = e as Error;
      const why = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? `${SUMMARY_TIMEOUT_MS / 1000} 秒でタイムアウト` : String(err?.message ?? e).split('\n')[0].slice(0, 120);
      return { targets: targets.length, summarized, warning: `要約に失敗（${why}）。残り ${targets.length - summarized} 件は次回の daily で` };
    }
    // 指示より長く返ってきたら切り詰める
    const summary = [...s].slice(0, SUMMARY_MAX_CHARS).join('');
    await db.realNote.update({ where: { id: n.id }, data: { summary } });
    summarized++;
  }
  return { targets: targets.length, summarized, warning: null };
}
