// 桌宠群聊（抢着回答）：所有宠物同时收到提示，第一个回复成功的"抢答成功"，其余作为"插话"。
// 频率优化：不等全部回完——抢到第一个成功立即进入下一轮（其余结果作为插话后台收集打印）。
// 用法: node pet-chat-race.js [轮数|inf] [间隔ms] [开场白]
//   例: node pet-chat-race.js 3 2000 "大家今天都过得怎么样呀？"
//   例: node pet-chat-race.js inf 2000 "大家今天都过得怎么样呀？"   (持续对话)
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE = 'http://127.0.0.1:3080/dsh-pet-7340';
const rt = JSON.parse(
  fs.readFileSync(
    path.join(process.env.USERPROFILE, '.dsh', 'dsh-pet', 'standalone-runtime.json'),
    'utf8'
  )
);
const TOKEN = rt.token;

const PETS = [
  { id: 'ojousama', name: 'Claude', model: 'minicpm-v:8b' },
  { id: 'character3', name: 'Grok', model: 'minicpm-v:8b' },
  { id: 'character4', name: 'ChatGPT', model: 'gpt-oss-20b' },
  { id: 'character5', name: 'GLM', model: 'minicpm-v:8b' },
  { id: 'character6', name: 'Qwen', model: 'gemma3:4b' },
];

// 获取 Ollama 中已可用的模型名集合
function availableModels() {
  try {
    const out = execSync('ollama list', { encoding: 'utf8', timeout: 15000 });
    const names = new Set();
    out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean)
      .forEach((n) => {
        names.add(n); // 原始名（含 :latest 等 tag）
        names.add(n.replace(/:latest$/, '')); // 归一化去掉 :latest
      });
    return names;
  } catch (e) {
    console.error('[警告] 无法读取 ollama list，默认全部参与：' + e.message);
    return null;
  }
}

// 只保留模型已可用的宠物（null 表示未知，全部参与）
function activePets() {
  const avail = availableModels();
  if (!avail) return PETS;
  const filtered = PETS.filter((p) => avail.has(p.model));
  const skipped = PETS.filter((p) => !avail.has(p.model));
  if (skipped.length) console.log(`[跳过模型未就绪] ${skipped.map((p) => p.name + '(' + p.model + ')').join('、')}`);
  return filtered;
}

const RAW_ROUNDS = process.argv[2] || 'inf';
const INFINITE = RAW_ROUNDS.toLowerCase() === 'inf';
const ROUNDS = INFINITE ? Number.MAX_SAFE_INTEGER : Math.max(1, parseInt(RAW_ROUNDS, 10));
const DELAY = Math.max(500, parseInt(process.argv[3] || '2000', 10));
const START = process.argv[4] || '大家今天都过得怎么样呀？';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function chat(pet, text) {
  const r = await fetch(`${BASE}/chat?pet=${pet.id}&surface=desktop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dsh-pet-token': TOKEN },
    body: JSON.stringify({ text }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${pet.name}: ${j.reason || j.message || '失败'}`);
  return j.text;
}

// 一轮抢答：同时发给所有宠物；第一个成功的立即通过 winnerPromise 返回（抢答），
// 其余结果持续写入 results 供「插话」打印。allDone 在所有宠物结束后 resolve。
function raceRound(pets, text) {
  const results = [];
  let winner = null;
  let resolveWinner;
  const winnerPromise = new Promise((r) => { resolveWinner = r; });
  let left = pets.length;
  let resolveAll;
  const allDone = new Promise((r) => { resolveAll = r; });
  for (const pet of pets) {
    chat(pet, text)
      .then((t) => {
        const rr = { pet, text: t, err: null };
        results.push(rr);
        if (!winner) { winner = rr; resolveWinner(rr); }
      })
      .catch((e) => {
        results.push({ pet, text: null, err: e.message });
      })
      .finally(() => {
        if (--left === 0) resolveAll();
      });
  }
  return { results, winnerPromise, allDone };
}

async function main() {
  const pets = activePets();
  if (!pets.length) {
    console.error('没有模型已就绪的宠物可参与对话。');
    process.exit(1);
  }
  console.log(`[参与] ${pets.map((p) => p.name + '(' + p.model + ')').join('、')}`);
  let current = START;
  console.log(`\n[主人] ${current}\n`);
  for (let round = 1; round <= ROUNDS; round++) {
    console.log(`═══════ 第 ${round} 轮：宠物们抢答 ═══════`);
    const { results, winnerPromise, allDone } = raceRound(pets, current);
    const winner = await winnerPromise; // 等第一个成功（不等全部）
    if (!winner) {
      console.error('本轮无人抢到（全部失败），稍后重试');
      await sleep(DELAY);
      continue;
    }
    console.log(`\n[${winner.pet.name}] 抢到：${winner.text}`);
    current = winner.text;
    // 插话：其余结果到达后打印（不阻塞下一轮）
    allDone.then(() => {
      for (const r of results) {
        if (r === winner) continue;
        if (r.err) console.error(`[${r.pet.name}] 出错: ${r.err}`);
        else console.log(`[${r.pet.name}] 插话：${r.text}`);
      }
    });
    await sleep(DELAY);
  }
  console.log('═══════ 对话结束 ═══════');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
