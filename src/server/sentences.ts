import { ACTIONS } from '../shared/protocol.ts';
import type { Action, Emotion } from '../shared/protocol.ts';
export interface ParsedSentence { text: string; emotion?: Emotion; action?: Action; style?: string }

export class SentenceStream {
  private text = '';
  private token = '';
  private tokenStart = '';
  private overflow = false;
  private emotion?: Emotion;
  private action?: Action;
  private style?: string;
  private emotionCount = 0;
  private actionCount = 0;
  private emotions: Set<string>;
  private onText: () => void;
  constructor(emotions: string[], onText: () => void) {
    this.emotions = new Set(emotions); this.onText = onText;
    this.emotion = (this.emotions.has('neutral') ? 'neutral' : emotions[0]) as Emotion | undefined;
  }
  push(chunk: string): ParsedSentence[] {
    const output: ParsedSentence[] = [];
    for (const character of chunk) {
      if (this.tokenStart) {
        const close = this.tokenStart === '<' ? '>' : this.tokenStart === '(' ? ')' : '）';
        if (character === close) {
          if (!this.overflow) this.control(this.tokenStart, this.token, close);
          this.token = ''; this.tokenStart = ''; this.overflow = false;
        } else if (this.token.length < 128) this.token += character; else this.overflow = true;
        continue;
      }
      if (['<', '(', '（'].includes(character)) { this.tokenStart = character; continue; }
      this.text += character;
      if (/[\p{L}\p{N}]/u.test(character)) this.onText();
      if (/[。！？!?\n]/.test(character) || (this.text.length >= 36 && /[，,；;]/.test(character))) {
        const sentence = this.flush(); if (sentence) output.push(sentence);
      }
    }
    return output;
  }
  finish(): ParsedSentence[] { const sentence = this.flush(); return sentence ? [sentence] : []; }
  private control(start: string, value: string, end: string) {
    if (start === '<') {
      const [name, argument] = value.split(':');
      if (name === 'emo' && this.emotions.has(argument) && this.emotionCount < 3) { this.emotion = argument as Emotion; this.emotionCount++; }
      if (name === 'act' && (ACTIONS as readonly string[]).includes(argument) && this.actionCount < 2) { this.action = argument as Action; this.actionCount++; }
    } else if (/^[\u4e00-\u9fff，、\s]{1,16}$/.test(value)) this.style = value;
    else this.text += start + value + end;
  }
  private flush(): ParsedSentence | undefined {
    let text = this.text.trim(); this.text = '';
    if (!/[\p{L}\p{N}]/u.test(text)) return;
    text = text.replace(/```[a-z]*\s*|```|\*\*|__/gi, '').replace(/^\s*[-#]\s+/, '').trim();
    if (/想你|等你回来|舍不得你/.test(text)) text = '我们轻松聊聊足球吧。';
    const sentence = { text, emotion: this.emotion, action: this.action, style: this.style };
    this.action = undefined; this.style = undefined; return sentence;
  }
}
