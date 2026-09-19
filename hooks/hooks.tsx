import type { Register } from 'claude-code';

const TOOL_NAME = 'pick';
const FULL_TOOL_NAME = 'mcp__better-ask-picker__pick';
const PANE_ID = 'ask-picker';

// hotkey は数字1桁か小文字1字。y/n は決定・キャンセル用に空けておく。
const HOTKEYS = '123456789abcdefghijklmopqrstuvwxz';
const CONFIRM_HOTKEY = 'y';
const CANCEL_HOTKEY = 'n';

// 待機の上限（$.process.run の timeoutMs 上限は10分）
const WAIT_TIMEOUT_MS = 600_000;

type Option = { label: string; description?: string };

type Session = {
  question: string;
  summary?: string;
  options: Option[];
  multiSelect: boolean;
  selected: Set<number>;
  status: 'open' | 'done' | 'cancelled';
  sentinel: string;
};

// 表示中の質問。ペインは1つだけ（同時に2件は受けない）。
let session: Session | null = null;

// フックの予算（10秒）は自分のコードの実行時間だけを数え、$ 呼び出しの実行中は止まる。
// 自作 Promise の await は止まらないので、人の回答待ちは「sentinel が現れるまで
// 待つ子プロセス」を $.process.run で待つ形にする。
const waitForAnswer = async ($: any, s: Session) => {
  await $.process.run(['sh', '-c', 'while [ ! -e "$1" ]; do sleep 0.2; done', 'sh', s.sentinel], {
    timeoutMs: WAIT_TIMEOUT_MS,
  });
};

const finish = async ($: any, s: Session, status: 'done' | 'cancelled') => {
  if (s.status !== 'open') return;
  s.status = status;
  await $.process.run(['touch', s.sentinel]);
};

const answerOf = (s: Session) =>
  s.status === 'done'
    ? { selected: [...s.selected].sort((a, b) => a - b).map((i) => s.options[i]?.label ?? '') }
    : { selected: [] as string[], cancelled: true };

// ペインを出せない環境（幅が足りない等）向け: ネイティブダイアログで4択ずつ聞く。
// multiSelect は4個ずつのチャンクをそれぞれ複数選択で聞いて連結する。
// 既知の制限: ラベルにカンマを含むと、複数選択の回答の分割がずれる。
const askWithNativeDialog = async ($: any, s: Session) => {
  const header = s.summary ? `${s.question}\n${s.summary}` : s.question;
  const labels = s.options.map((o) => o.label);
  try {
    if (s.multiSelect) {
      const chunks: string[][] = [];
      for (let i = 0; i < labels.length; i += 4) chunks.push(labels.slice(i, i + 4));
      const picked: string[] = [];
      for (const [n, chunk] of chunks.entries()) {
        const q = chunks.length > 1 ? `${header} (${n + 1}/${chunks.length})` : header;
        const answer: string = await $.ui.ask(q, { options: chunk, multiSelect: true });
        picked.push(
          ...answer
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        );
      }
      return { selected: picked };
    }
    const Prev = '← 前へ';
    const Next = '→ 次へ';
    const pageCount = Math.ceil(labels.length / 2);
    let page = 0;
    while (true) {
      const start = page * 2;
      const nav: string[] = [];
      if (page > 0) nav.push(Prev);
      if (start + 2 < labels.length) nav.push(Next);
      const q = pageCount > 1 ? `${header} (${page + 1}/${pageCount})` : header;
      const chosen: string = await $.ui.ask(q, [...labels.slice(start, start + 2), ...nav]);
      if (chosen === Next) page += 1;
      else if (chosen === Prev) page -= 1;
      else return { selected: [chosen] };
    }
  } catch {
    return { selected: [] as string[], cancelled: true };
  }
};

const parseInput = (
  e: unknown
):
  | { ok: true; value: Omit<Session, 'selected' | 'status' | 'sentinel'> }
  | { ok: false; error: string } => {
  const input = e as {
    question?: unknown;
    summary?: unknown;
    options?: unknown;
    multiSelect?: unknown;
  };
  if (typeof input.question !== 'string' || input.question.length === 0) {
    return { ok: false, error: 'question が空です' };
  }
  if (!Array.isArray(input.options) || input.options.length < 2) {
    return { ok: false, error: 'options には2個以上の選択肢が必要です' };
  }
  const options: Option[] = [];
  for (const raw of input.options) {
    const o = raw as { label?: unknown; description?: unknown };
    if (typeof o?.label !== 'string' || o.label.length === 0) {
      return { ok: false, error: '各 option には空でない label が必要です' };
    }
    options.push({
      label: o.label,
      description: typeof o.description === 'string' && o.description ? o.description : undefined,
    });
  }
  return {
    ok: true,
    value: {
      question: input.question,
      summary: typeof input.summary === 'string' && input.summary ? input.summary : undefined,
      options,
      multiSelect: input.multiSelect === true,
    },
  };
};

export const register: Register = (on, _options) => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: TOOL_NAME,
      description:
        '質問の概要を表示しつつ、選択肢を全件1画面に出してユーザーに選ばせる。' +
        '選択肢の数に上限はなく、multiSelect で複数選択もできる。' +
        '戻り値は JSON 文字列 {"selected": [選んだlabel...]}（キャンセル時は cancelled: true）。',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '質問文（?で終わる）' },
          summary: { type: 'string', description: '質問の概要・背景（Markdown、任意）' },
          options: {
            type: 'array',
            minItems: 2,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: '選択肢のラベル' },
                description: { type: 'string', description: '選択肢の説明（任意）' },
              },
              required: ['label'],
            },
            description: '選択肢の一覧（上限なし）',
          },
          multiSelect: { type: 'boolean', description: 'true で複数選択（決定ボタンで確定）' },
        },
        required: ['question', 'options'],
      },
    });
    // 前回のモジュールが残したペインを片付ける
    try {
      if ((await $.ui.panes()).some((p) => p.id === PANE_ID)) await $.ui.close({ id: PANE_ID });
    } catch {}
    return next(e);
  });

  on('tool.call', { tool: FULL_TOOL_NAME }, async ($, e, next) => {
    const parsed = parseInput(e);
    if (!parsed.ok) return { deny: parsed.error };
    if (session && session.status === 'open') {
      return { deny: '別の質問を表示中です。回答を待ってから呼び直してください' };
    }

    const s: Session = {
      ...parsed.value,
      selected: new Set(),
      status: 'open',
      sentinel: `/tmp/ask-picker-${Date.now()}-${Math.floor(Math.random() * 1e9)}.done`,
    };
    session = s;
    const onAbort = () => void finish($, s, 'cancelled');
    next.signal.addEventListener('abort', onAbort);

    try {
      const rows = Math.min(
        24,
        6 + s.options.length * (s.options.some((o) => o.description) ? 2 : 1) + (s.summary ? 3 : 0)
      );
      await $.ui.open({
        id: PANE_ID,
        title: '質問',
        focus: true,
        closeOnEscape: true,
        holdToasts: true,
        rows,
      });

      const pane = (await $.ui.panes()).find((p) => p.id === PANE_ID);
      if (!pane?.isPlaced) {
        // 端末幅が足りずペインが描画されない: 待たずにネイティブダイアログへ
        await $.ui.close({ id: PANE_ID });
        const fallback = await askWithNativeDialog($, s);
        return {
          result: JSON.stringify(fallback),
          context: [`answered (native dialog): ${JSON.stringify(fallback)}`],
        };
      }
      if (!pane.isFocused) $.ui.toast('ペインを選ぶには ctrl+x の後に tab キー');

      await waitForAnswer($, s);
      if (s.status === 'open') s.status = 'cancelled';

      const answer = answerOf(s);
      return { result: JSON.stringify(answer), context: [`answered: ${JSON.stringify(answer)}`] };
    } catch (err) {
      return {
        deny: `質問を表示できませんでした: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      next.signal.removeEventListener('abort', onAbort);
      if (session === s) session = null;
      if (s.status === 'open') s.status = 'cancelled';
      try {
        await $.ui.close({ id: PANE_ID });
      } catch {}
      try {
        await $.process.run(['rm', '-f', s.sentinel]);
      } catch {}
    }
  });

  // ユーザーがペインを閉じた（Esc・×）ときはキャンセル扱いで待機を解く
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE_ID && e.origin.kind === 'person' && session)
      void finish($, session, 'cancelled');
    return next(e);
  });

  on('ui.render', { component: 'Pane' }, ($, e, next) => {
    const s = session;
    if (e.requestId !== PANE_ID || !s || s.status !== 'open') return next(e);

    const { Box, Text, Button, Markdown } = $.ui.resolve(e);

    const press = (i: number) => {
      if (s.status !== 'open') return;
      if (!s.multiSelect) {
        s.selected = new Set([i]);
        void finish($, s, 'done');
        return;
      }
      if (s.selected.has(i)) s.selected.delete(i);
      else s.selected.add(i);
      $.ui.invalidate('ui.render');
    };

    const heading = s.summary ? `**${s.question}**\n\n${s.summary}` : `**${s.question}**`;

    return (
      <Box flexDirection="column">
        <Markdown text={heading} />
        <Box flexDirection="column" marginTop={1}>
          {s.options.map((o, i) => (
            <Box flexDirection="column">
              <Button
                key={`opt-${i}`}
                plain
                autoFocus={i === 0 ? true : undefined}
                hotkey={HOTKEYS[i]}
                label={s.multiSelect ? `${s.selected.has(i) ? '[x]' : '[ ]'} ${o.label}` : o.label}
                onPress={() => press(i)}
              />
              {o.description ? (
                <Box paddingLeft={4}>
                  <Text dimColor wrap="wrap">
                    {o.description}
                  </Text>
                </Box>
              ) : null}
            </Box>
          ))}
        </Box>
        <Box marginTop={1} gap={2}>
          {s.multiSelect ? (
            <Button
              key="confirm"
              plain
              hotkey={CONFIRM_HOTKEY}
              label={`決定 (${s.selected.size}件)`}
              onPress={() => void finish($, s, 'done')}
            />
          ) : null}
          <Button
            key="cancel"
            plain
            hotkey={CANCEL_HOTKEY}
            label="キャンセル"
            onPress={() => void finish($, s, 'cancelled')}
          />
        </Box>
      </Box>
    );
  });
};
