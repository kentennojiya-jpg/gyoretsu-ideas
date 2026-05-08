// ============================================================
// 行列ラボ アイデアストック - Vercel Functions
// Notion APIへの中継サーバー（トークンを安全に保管）
// ============================================================

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// カテゴリ・優先度のマッピング（フロント値 → Notion値）
const CAT_MAP = {
  ux:    'UX・接客',
  ops:   'オペレーション',
  menu:  'メニュー・商品',
  mkt:   '集客・マーケ',
  other: 'その他'
};
const CAT_REV = Object.fromEntries(Object.entries(CAT_MAP).map(([k, v]) => [v, k]));

const PRI_MAP = { high: '高', mid: '中', low: '低' };
const PRI_REV = Object.fromEntries(Object.entries(PRI_MAP).map(([k, v]) => [v, k]));

// Notion API共通ヘッダ
function notionHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_VERSION
  };
}

// メインハンドラ
export default async function handler(req, res) {
  // CORSヘッダ
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DB_ID;

  if (!token || !dbId) {
    return res.status(500).json({ error: 'Notion設定が未完了です。環境変数を確認してください。' });
  }

  try {
    // GET: アイデア一覧取得
    if (req.method === 'GET') {
      return await handleList(req, res, token, dbId);
    }
    // POST: アイデア新規作成
    if (req.method === 'POST') {
      return await handleCreate(req, res, token, dbId);
    }
    // PATCH: アイデア更新（削除フラグ等）
    if (req.method === 'PATCH') {
      return await handleUpdate(req, res, token);
    }
    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (e) {
    console.error('API Error:', e);
    return res.status(500).json({ error: e.message || 'Internal Error' });
  }
}

// ============================================================
// GET: アイデア一覧取得（削除フラグfalseのみ）
// ============================================================
async function handleList(req, res, token, dbId) {
  const r = await fetch(`${NOTION_API_BASE}/databases/${dbId}/query`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({
      filter: {
        or: [
          { property: '削除フラグ', checkbox: { equals: false } }
        ]
      },
      sorts: [
        { property: '登録日時', direction: 'descending' }
      ],
      page_size: 100
    })
  });

  if (!r.ok) {
    const errText = await r.text();
    return res.status(r.status).json({ error: `Notion API Error: ${errText}` });
  }

  const data = await r.json();
  const ideas = data.results.map(page => notionToIdea(page));
  return res.status(200).json({ ideas });
}

// ============================================================
// POST: アイデア新規作成
// ============================================================
async function handleCreate(req, res, token, dbId) {
  const { title, body, category, priority, originalId } = req.body || {};

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'タイトルは必須です' });
  }

  const props = {
    'アイデア内容': {
      title: [{ text: { content: title.trim() } }]
    },
    'カテゴリ': {
      select: { name: CAT_MAP[category] || CAT_MAP.other }
    },
    '優先度': {
      select: { name: PRI_MAP[priority] || PRI_MAP.mid }
    },
    '削除フラグ': { checkbox: false }
  };

  if (body && body.trim()) {
    props['詳細メモ'] = { rich_text: [{ text: { content: body.trim() } }] };
  }
  if (originalId) {
    props['元データID'] = { rich_text: [{ text: { content: String(originalId) } }] };
  }

  const r = await fetch(`${NOTION_API_BASE}/pages`, {
    method: 'POST',
    headers: notionHeaders(token),
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties: props
    })
  });

  if (!r.ok) {
    const errText = await r.text();
    return res.status(r.status).json({ error: `Notion API Error: ${errText}` });
  }

  const page = await r.json();
  return res.status(200).json({ idea: notionToIdea(page) });
}

// ============================================================
// PATCH: アイデア更新（削除フラグ立てる等）
// ============================================================
async function handleUpdate(req, res, token) {
  const { id, action } = req.body || {};

  if (!id) {
    return res.status(400).json({ error: 'idは必須です' });
  }

  const props = {};
  if (action === 'delete') {
    props['削除フラグ'] = { checkbox: true };
  } else {
    return res.status(400).json({ error: '不正なactionです' });
  }

  const r = await fetch(`${NOTION_API_BASE}/pages/${id}`, {
    method: 'PATCH',
    headers: notionHeaders(token),
    body: JSON.stringify({ properties: props })
  });

  if (!r.ok) {
    const errText = await r.text();
    return res.status(r.status).json({ error: `Notion API Error: ${errText}` });
  }

  return res.status(200).json({ ok: true });
}

// ============================================================
// Notion ページ → フロント用 idea オブジェクトへ変換
// ============================================================
function notionToIdea(page) {
  const p = page.properties;
  const title = p['アイデア内容']?.title?.[0]?.plain_text || '';
  const body = p['詳細メモ']?.rich_text?.[0]?.plain_text || '';
  const catName = p['カテゴリ']?.select?.name || 'その他';
  const priName = p['優先度']?.select?.name || '中';
  const createdTime = page.created_time;

  // 日付フォーマット yyyy/MM/dd HH:mm
  const d = new Date(createdTime);
  const dateStr =
    d.getFullYear() + '/' +
    String(d.getMonth() + 1).padStart(2, '0') + '/' +
    String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0');

  return {
    id: page.id,
    title,
    body,
    category: CAT_REV[catName] || 'other',
    priority: PRI_REV[priName] || 'mid',
    date: dateStr,
    ts: new Date(createdTime).getTime()
  };
}
