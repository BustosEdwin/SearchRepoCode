/// <reference lib="webworker" />
import { MatchStore, NewMatch, Query, ResultParser } from './match-store';

const store = new MatchStore();

type Msg =
  | { type: 'reset' }
  | { type: 'append'; items: NewMatch[] }
  | { type: 'load'; reqId: number; blob: Blob }
  | { type: 'query'; reqId: number; query: Query; limit: number }
  | { type: 'rows'; reqId: number; from: number; to: number }
  | { type: 'ids'; reqId: number }
  | { type: 'byIds'; reqId: number; ids: number[] };

async function load(reqId: number, blob: Blob) {
  store.reset();
  const parser = new ResultParser(store);
  const decoder = new TextDecoder('utf-8');
  const reader = blob.stream().getReader();
  let loaded = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.length;
    parser.feed(decoder.decode(value, { stream: true }));
    const now = Date.now();
    if (now - last > 100) {
      last = now;
      postMessage({ type: 'progress', loaded, size: blob.size });
    }
  }
  parser.feed(decoder.decode());
  parser.finish();
  postMessage({ type: 'done', reqId, term: parser.term, total: store.count });
}

addEventListener('message', ({ data }: MessageEvent<Msg>) => {
  try {
    switch (data.type) {
      case 'reset':
        store.reset();
        break;
      case 'append':
        store.addMany(data.items);
        break;
      case 'load':
        load(data.reqId, data.blob).catch((e) => postMessage({ type: 'error', reqId: data.reqId, message: String(e?.message ?? e) }));
        break;
      case 'query':
        postMessage({ type: 'done', reqId: data.reqId, result: store.query(data.query, data.limit) });
        break;
      case 'rows':
        postMessage({ type: 'done', reqId: data.reqId, rows: store.rows(data.from, data.to) });
        break;
      case 'ids': {
        const ids = store.filteredIds();
        postMessage({ type: 'done', reqId: data.reqId, ids }, [ids.buffer]);
        break;
      }
      case 'byIds':
        postMessage({ type: 'done', reqId: data.reqId, rows: store.byIds(data.ids) });
        break;
    }
  } catch (e) {
    postMessage({ type: 'error', reqId: (data as { reqId?: number }).reqId, message: String((e as Error)?.message ?? e) });
  }
});
