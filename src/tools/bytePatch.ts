import { TextDecoder } from 'node:util';

interface Line { text: string; eol: string }
interface EditLine { kind: string; text: string; noNewline: boolean }
function utf8(bytes: Buffer): string {
  if (bytes.includes(0)) throw new Error('UNSUPPORTED_FORMAT: NUL content');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
function lines(text: string): Line[] {
  const out: Line[] = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m[0].length) out.push({ text: m[1], eol: m[2] });
  return out;
}

/** One-file unified text patch. Context bytes/terminators survive unchanged.
 * Replacements inherit removed line terminators by position. Additional inserted
 * lines use nearest preceding terminator, then following, then LF. Explicit
 * "No newline" markers control only the specified side's last line.
 */
export function patchBytes(before: Buffer | null, patch: string): Buffer {
  if (Buffer.from(patch,'utf8').toString('utf8')!==patch) throw new Error('INVALID_PATCH_UTF8');
  if (/^new file mode (?!100644$)/m.test(patch)) throw new Error('UNSUPPORTED_FILE_MODE');
  if (Buffer.byteLength(patch) > 1024 * 1024) throw new Error('PATCH_TOO_LARGE');
  if (/^(?:GIT binary patch|Binary files|rename |copy |old mode|new mode)/m.test(patch)) throw new Error('UNSUPPORTED_PATCH');
  if ((patch.match(/^--- /gm) || []).length !== 1 || (patch.match(/^\+\+\+ /gm) || []).length !== 1) throw new Error('SINGLE_FILE_ONLY');
  const sourceText = before ? utf8(before) : '';
  const bom = sourceText.startsWith('\uFEFF') ? '\uFEFF' : '';
  const original = lines(bom ? sourceText.slice(1) : sourceText);
  const parts = patch.split(/\r?\n/);
  const h = parts.findIndex(p => p.startsWith('+++ '));
  if (h < 1 || !parts[h - 1].startsWith('--- ')) throw new Error('INVALID_HEADERS');
  const creates = parts[h - 1] === '--- /dev/null';
  if (creates !== (before === null)) throw new Error('SOURCE_EXISTENCE_MISMATCH');
  const output: Line[] = [];
  let cursor = 0, sawHunk = false;
  for (let i = h + 1; i < parts.length;) {
    if (parts[i] === '' && i === parts.length - 1) break;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(parts[i++]);
    if (!match) throw new Error('INVALID_HUNK_HEADER');
    sawHunk = true;
    const oldStart = Number(match[1]), oldCount = Number(match[2] ?? 1);
    const newStart = Number(match[3]), newCount = Number(match[4] ?? 1);
    const start = oldCount === 0 ? oldStart : oldStart - 1;
    if (start < cursor || start > original.length) throw new Error('INVALID_HUNK_RANGE');
    output.push(...original.slice(cursor, start)); cursor = start;
    if ((newCount === 0 ? newStart : newStart - 1) !== output.length) throw new Error('INVALID_NEW_RANGE');
    const edits: EditLine[] = [];
    while (i < parts.length && !parts[i].startsWith('@@ ')) {
      const p = parts[i++];
      if (p === '' && i === parts.length) break;
      if (p === '\\ No newline at end of file') {
        if (!edits.length || edits[edits.length - 1].noNewline) throw new Error('INVALID_NO_NEWLINE_MARKER');
        edits[edits.length - 1].noNewline = true; continue;
      }
      if (![' ', '-', '+'].includes(p[0])) throw new Error('INVALID_HUNK_LINE');
      edits.push({kind: p[0], text: p.slice(1), noNewline: false});
    }
    if (edits.filter(e => e.kind !== '+').length !== oldCount ||
        edits.filter(e => e.kind !== '-').length !== newCount) throw new Error('HUNK_COUNT_MISMATCH');
    for (let j = 0; j < edits.length;) {
      const e = edits[j];
      if (e.kind === ' ') {
        const old = original[cursor++];
        if (!old || old.text !== (bom && cursor===1 ? e.text.replace(/^\uFEFF/, "") : e.text) || e.noNewline !== (old.eol === '')) throw new Error('CONTEXT_MISMATCH');
        output.push(old); j++; continue;
      }
      const removed: Line[] = [], added: EditLine[] = [];
      while (j < edits.length && edits[j].kind !== ' ') {
        const edit = edits[j++];
        if (edit.kind === '-') {
          const old = original[cursor++];
          if (!old || old.text !== (bom && cursor===1 ? edit.text.replace(/^\uFEFF/, "") : edit.text) || edit.noNewline !== (old.eol === '')) throw new Error('CONTEXT_MISMATCH');
          removed.push(old);
        } else added.push(edit);
      }
      const nearby = removed.find(l => l.eol)?.eol ||
        [...output].reverse().find(l => l.eol)?.eol ||
        original.slice(cursor).find(l => l.eol)?.eol || '\n';
      for (let k = 0; k < added.length; k++) {
        const a = added[k];
        output.push({ text: bom&&output.length===0?a.text.replace(/^\uFEFF/, ""):a.text, eol: a.noNewline ? '' : (removed[k]?.eol || nearby) });
      }
    }
  }
  if (!sawHunk) throw new Error('NO_HUNKS');
  output.push(...original.slice(cursor));
  if (output.slice(0, -1).some(l => l.eol === '')) throw new Error('INVALID_FINAL_NEWLINE');
  const result = Buffer.from(bom + output.map(l => l.text + l.eol).join(''), 'utf8');
  utf8(result); // Reject invalid surrogate input after encoding semantics are resolved.
  return result;
}
