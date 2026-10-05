import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveShotFile, resolveShotUrlFile, shotUrl } from '@/lib/paper/shots';

let tmp: string;
let root: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shots-'));
  root = path.join(tmp, 'paper', 'shots');
  fs.mkdirSync(path.join(root, '2026-10-01'), { recursive: true });
  fs.writeFileSync(path.join(root, '2026-10-01', 'a.png'), 'png');
  fs.writeFileSync(path.join(root, '2026-10-01', 'notes.txt'), 'x');
  fs.writeFileSync(path.join(tmp, 'paper', 'events.jsonl'), 'secret');
  fs.writeFileSync(path.join(tmp, 'outside.png'), 'outside');
  fs.symlinkSync(path.join(tmp, 'outside.png'), path.join(root, 'link.png'));
  fs.mkdirSync(path.join(tmp, 'outdir'));
  fs.writeFileSync(path.join(tmp, 'outdir', 'b.png'), 'b');
  fs.symlinkSync(path.join(tmp, 'outdir'), path.join(root, 'linkdir'));
  fs.mkdirSync(path.join(tmp, 'paper', 'replay', 'shots', '2026-10-02'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'paper', 'replay', 'shots', '2026-10-02', 'r.png'), 'png');
  fs.writeFileSync(path.join(tmp, 'paper', 'replay', 'events.jsonl'), 'secret');
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('resolveShotFile', () => {
  it('shots 配下の PNG は実パスを返す', () => {
    expect(resolveShotFile(root, ['2026-10-01', 'a.png'])).toBe(fs.realpathSync(path.join(root, '2026-10-01', 'a.png')));
  });
  it('.. や空要素・区切り文字を含むものは拒否', () => {
    expect(resolveShotFile(root, ['..', 'events.jsonl'])).toBeNull();
    expect(resolveShotFile(root, ['..', 'outside.png'])).toBeNull();
    expect(resolveShotFile(root, ['2026-10-01', '..', '..', 'outside.png'])).toBeNull();
    expect(resolveShotFile(root, ['2026-10-01/../a.png'])).toBeNull();
    expect(resolveShotFile(root, ['2026-10-01\\a.png'])).toBeNull();
    expect(resolveShotFile(root, ['', 'a.png'])).toBeNull();
    expect(resolveShotFile(root, ['.', '2026-10-01', 'a.png'])).toBeNull();
  });
  it('絶対パス風のセグメントは拒否', () => {
    expect(resolveShotFile(root, ['/etc/passwd'])).toBeNull();
    expect(resolveShotFile(root, [path.join(tmp, 'outside.png')])).toBeNull();
  });
  it('.png 以外は拒否（大文字小文字は区別しない）', () => {
    expect(resolveShotFile(root, ['2026-10-01', 'notes.txt'])).toBeNull();
    expect(resolveShotFile(root, ['2026-10-01', 'a.png.txt'])).toBeNull();
  });
  it('NUL を含むものは拒否', () => {
    expect(resolveShotFile(root, ['2026-10-01', 'a.png\0.txt'])).toBeNull();
    expect(resolveShotFile(root, ['2026-10-01', 'a\0.png'])).toBeNull();
  });
  it('shots の外を指すシンボリックリンク（ファイル・ディレクトリ）は拒否', () => {
    expect(resolveShotFile(root, ['link.png'])).toBeNull();
    expect(resolveShotFile(root, ['linkdir', 'b.png'])).toBeNull();
  });
  it('存在しない・ディレクトリは null', () => {
    expect(resolveShotFile(root, ['2026-10-01', 'none.png'])).toBeNull();
    expect(resolveShotFile(root, [])).toBeNull();
    fs.mkdirSync(path.join(root, 'd.png'));
    expect(resolveShotFile(root, ['d.png'])).toBeNull();
  });
});

describe('shotUrl', () => {
  it('DB の path（shots/…）→ 配信 URL', () => {
    expect(shotUrl('shots/2026-10-01/abc.png')).toBe('/shots/2026-10-01/abc.png');
  });
  it('shots/ 配下でないものは null', () => {
    expect(shotUrl('events.jsonl')).toBeNull();
    expect(shotUrl('../x.png')).toBeNull();
    expect(shotUrl('shots')).toBeNull();
    expect(shotUrl('replay/events.jsonl')).toBeNull();
    expect(shotUrl('replay/shots')).toBeNull();
    expect(shotUrl('replay/x/a.png')).toBeNull();
  });
  it('リプレイの path（replay/shots/…）→ /shots/replay/…', () => {
    expect(shotUrl('replay/shots/2026-10-02/abc.png')).toBe('/shots/replay/2026-10-02/abc.png');
  });
});

describe('resolveShotUrlFile（/shots/... の URL → paper 配下の実ファイル）', () => {
  const paper = () => path.join(tmp, 'paper');
  it('shots/ と replay/shots/ の PNG を返す', () => {
    expect(resolveShotUrlFile(paper(), ['2026-10-01', 'a.png'])).toBe(fs.realpathSync(path.join(root, '2026-10-01', 'a.png')));
    expect(resolveShotUrlFile(paper(), ['replay', '2026-10-02', 'r.png'])).toBe(
      fs.realpathSync(path.join(paper(), 'replay', 'shots', '2026-10-02', 'r.png')),
    );
  });
  it('replay/shots の外へ出るもの・PNG 以外・replay だけは拒否', () => {
    expect(resolveShotUrlFile(paper(), ['replay'])).toBeNull();
    expect(resolveShotUrlFile(paper(), ['replay', '..', 'events.jsonl'])).toBeNull();
    expect(resolveShotUrlFile(paper(), ['replay', '..', '..', 'shots', '2026-10-01', 'a.png'])).toBeNull();
    expect(resolveShotUrlFile(paper(), ['replay', '..', '..', '..', 'outside.png'])).toBeNull();
    expect(resolveShotUrlFile(paper(), ['replay', '2026-10-02/../../events.jsonl'])).toBeNull();
    expect(resolveShotUrlFile(paper(), ['replay', '2026-10-02', 'none.png'])).toBeNull();
    expect(resolveShotUrlFile(paper(), ['..', 'replay', 'events.jsonl'])).toBeNull();
    expect(resolveShotUrlFile(paper(), ['..', 'outside.png'])).toBeNull();
  });
});
