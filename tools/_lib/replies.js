// 歇一会 - 文案系统：预生成提示词、按类型解析、通用本地兜底与档案

export const EFFECT_TYPES = ["reply", "move", "extend", "stall", "confiscate"];

export const EFFECT_LABELS = {
  reply: "普通",
  move: "躲",
  extend: "加时",
  stall: "停滞",
  confiscate: "没收",
};

const GENERIC_FALLBACK_STYLE = "自然、真诚地关心屏幕前的人，并沿用你平时的称呼和说话方式；不要编造对方的姓名或正在做的事。";

// 模型与台词档案都暂时不可用时的最后防线。
// 文案不绑定任何助手、用户姓名或私人经历，新增/删除助手时无需更新这里。
const FALLBACK_REPLIES = {
  reply: [
    "先把手放下，歇一会儿。事情可以等几分钟，眼睛和肩颈已经等很久了。",
    "又点了一次。现在需要的不是再撑一会儿，是让身体真正缓下来。",
    "别急着回到屏幕前，先喝口水、看看远处，把这段休息守完。",
    "我会陪你等到倒计时结束，先别再和按钮较劲了。",
  ],
  move: [
    "按钮跑开了，看来它也想让你把手放下。",
    "追按钮太费眼，不如趁现在看看远处、活动一下肩颈。",
    "它先躲一会儿，你也趁机歇一会儿。",
    "按钮不想被按到，这次就听它的，安静休息吧。",
  ],
  extend: [
    "又点了一次，休息时间也跟着变长了。现在停手还来得及。",
    "倒计时往回走了。继续点击只会让这段休息更久。",
    "每点一次都会多记一点时间，还是安心歇着更划算。",
    "加时已经记下了，把手放开，让倒计时自己走完。",
  ],
  stall: [
    "倒计时暂时停住了，正好给你几秒安静下来。",
    "数字现在不会动，先别盯着它，闭眼缓一缓。",
    "时间被按住了一会儿，你也跟着停一停吧。",
    "这几秒没有别的任务，只要呼吸和放松。",
  ],
  confiscate: [
    "按钮先收起来一小会儿，趁现在把手和眼睛都放松下来。",
    "按钮暂时不见了，不用找，安心歇一会儿。",
    "现在没有可以点的东西了，正好安静休息。",
    "按钮过一会儿会回来，你先做一次慢慢的深呼吸。",
  ],
};

export const PRAISE_REPLIES = [
  "这次休息守得很漂亮，身体会记住你的好。",
  "完整地休息完，比勉强多撑一会儿更值得夸。",
  "很好，休息是在给接下来的自己补充力气。",
  "把这次休息守完，也是在认真照顾自己。",
  "倒计时走完了，眼睛和肩膀终于能松一口气。",
  "好好歇完这一会儿，接下来会舒服很多。",
  "守住了这次休息，也守住了自己的状态。",
  "休息结束了，慢慢回来，不用立刻把自己拧紧。",
];

export function pickActiveAgent(agents = [], sessions = []) {
  const current = agents.find((agent) => agent?.isCurrent);
  if (current) return current;

  const newestSession = pickNewestSession(sessions);
  if (newestSession) {
    const matched = agents.find((agent) => agent?.id === newestSession.agentId);
    if (matched) return matched;
  }

  // 会话可能在助手删除后继续留存，不能让旧会话把已删除助手“复活”。
  return agents.find((agent) => agent?.isPrimary) || agents[0] || { id: "", name: "当前助手" };
}

export function pickSessionForAgent(sessions = [], agentId) {
  const candidates = sessions.filter((session) => {
    if (!session || session.visibility !== "public") return false;
    return !agentId || session.agentId === agentId;
  });
  return pickNewestSession(candidates);
}

function pickNewestSession(sessions = []) {
  return [...sessions]
    .filter(Boolean)
    .sort((a, b) => toTime(b.modified) - toTime(a.modified))[0] || null;
}

function toTime(value) {
  const time = value instanceof Date ? value.getTime() : Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

export function messagesToContext(messages = [], limit = 8) {
  return messages
    .filter((message) => message && (message.role === "user" || message.role === "assistant"))
    .slice(-limit)
    .map((message) => {
      const text = contentToText(message.content)
        .replace(/<mood>[\s\S]*?<\/mood>/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 260);
      if (!text) return "";
      return `${message.role === "user" ? "对方" : "助手"}：${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

export function buildReplyPrompt({ agentId, agentName, identity, context, clickCount }) {
  const personality = String(identity || "").trim().slice(0, 3000) || GENERIC_FALLBACK_STYLE;

  return `你是${agentName || agentId || "当前助手"}。以下是你的性格与表达方式：\n${personality}\n\n` +
    `屏幕前的人正在全屏休息提醒里，第${clickCount}次点击“跳过本次休息”。你需要立刻回应，阻止对方继续工作。\n` +
    `${context ? `你们刚才正在做或聊的事：\n${context}\n\n` : ""}` +
    `请结合刚才的具体内容，用你平时称呼对方、和对方说话的口吻自然回应。可以有一点警告、生气、心疼、吐槽或命令感，程度要符合你的性格和点击次数。\n` +
    `${context ? "必须准确提到上方对话里正在做的具体事情；禁止擅自改成写作业、加班或其他没有出现的场景。\n" : "没有读到具体上下文时，只谈休息和身体，不要编造姓名或正在做的事。\n"}` +
    `只输出一段自然口语，1至3句，18至70个汉字。不要自称AI，不要解释任务，不要复述规则，不要使用固定模板。`;
}

export function buildReplyBatchPrompt({ agentId, agentName, identity, context, countPerType = 2 }) {
  const personality = String(identity || "").trim().slice(0, 3000) || GENERIC_FALLBACK_STYLE;

  return `你是${agentName || agentId || "当前助手"}。以下是你的性格与表达方式：\n${personality}\n\n` +
    `休息窗口即将打开，请提前准备几组短回复，给之后可能连续点击“跳过本次休息”的对方。` +
    `语气要随着点击变多而更坚定或更心疼，但始终符合你的性格，并沿用你平时对对方的称呼。\n` +
    `${context ? `你们刚才正在做或聊的事：\n${context}\n\n` : ""}` +
    `请按以下五种情况各准备${countPerType}条互不重复的回复：\n` +
    `【普通】对方只是点了一下跳过，你单纯劝阻。\n` +
    `【躲】跳过按钮被追着点，按钮正在逃跑躲避，你要调侃这件事，别让对方继续追。\n` +
    `【加时】连续跳过导致休息时长增加了，你要吐槽或记仇，劝对方别跳了。\n` +
    `【停滞】倒计时被按住了几秒不动，你要调侃或解释这件事。\n` +
    `【没收】对方一直点跳过，你把跳过按钮没收了（按钮会消失一小会儿），你要调侃这件事。\n` +
    `${context ? "至少一半的【普通】要自然提到上方对话里的具体事情，禁止擅自改成写作业、加班或其他没有出现的场景。\n" : "没有具体上下文时，只谈休息和身体，不要编造姓名或正在做的事。\n"}` +
    `每条1至3句、18至70个汉字。每行只输出一条，行首必须是【普通】【躲】【加时】【停滞】【没收】五个标签之一，不要序号、引号、解释或 Markdown。` +
    `可以调侃或劝阻，但不要编造修改密码、删除文件、伤害人等现实威胁。`;
}

const TYPE_MARKERS = [
  { label: "普通", effect: "reply" },
  { label: "劝阻", effect: "reply" },
  { label: "躲", effect: "move" },
  { label: "划走", effect: "move" },
  { label: "逃跑", effect: "move" },
  { label: "加时", effect: "extend" },
  { label: "时长", effect: "extend" },
  { label: "停滞", effect: "stall" },
  { label: "停住", effect: "stall" },
  { label: "暂停", effect: "stall" },
  { label: "没收", effect: "confiscate" },
  { label: "消失", effect: "confiscate" },
];

export function parseReplyBatchByType(value, countPerType = 2) {
  let text = typeof value === "string" ? value : "";
  text = text
    .replace(/<mood>[\s\S]*?<\/mood>/gi, "")
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/\s*```$/g, "")
    .trim();

  const grouped = Object.fromEntries(EFFECT_TYPES.map((effect) => [effect, []]));
  let lines = [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) lines = parsed.map((item) => String(item || ""));
  } catch {
    lines = text.split(/\r?\n/);
  }

  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    const tagMatch = line.match(/^【(.{1,6})】(.*)$/s);
    let effect = "reply";
    let content = line;
    if (tagMatch) {
      const label = tagMatch[1];
      content = tagMatch[2];
      const marker = TYPE_MARKERS.find((item) => item.label === label);
      if (marker) effect = marker.effect;
    }
    const cleaned = cleanReplyText(content.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, ""));
    if (cleaned.length < 4) continue;
    if (grouped[effect].length < countPerType) grouped[effect].push(cleaned);
  }
  return grouped;
}

export function parseReplyBatch(value, limit = 4) {
  const grouped = parseReplyBatchByType(value, 99);
  return grouped.reply.slice(0, limit);
}

export function createRoundRobin(items = []) {
  const list = items.filter(Boolean);
  let index = 0;
  function roundRobinPick() {
    if (!list.length) return null;
    const item = list[index % list.length];
    index += 1;
    return item;
  }
  roundRobinPick.remainingCount = () => (list.length ? list.length - (index % list.length) : 0);
  return roundRobinPick;
}

export function makePoolPickers(pool = {}) {
  const pools = {};
  const used = new Set();
  for (const effect of EFFECT_TYPES) {
    pools[effect] = (Array.isArray(pool?.[effect]) ? pool[effect] : []).filter(Boolean);
  }
  return {
    take(effect = "reply") {
      const list = pools[effect] || pools.reply;
      if (!list.length) return null;
      const item = list.splice(0, 1)[0];
      used.add(`${effect}|${item}`);
      return item;
    },
    remaining(effect) {
      return (pools[effect] || pools.reply).length;
    },
    refill(effect, items = []) {
      const list = pools[effect] || pools.reply;
      for (const item of items) {
        if (!item) continue;
        const key = `${effect}|${item}`;
        if (used.has(key) || list.includes(item)) continue;
        list.push(item);
      }
    },
  };
}

export function pickReplyFromPool(poolOrList, clickCount = 1) {
  const list = Array.isArray(poolOrList) ? poolOrList : poolOrList?.reply || [];
  const index = Math.max(1, Number(clickCount) || 1) - 1;
  return list[index] || "";
}

const fallbackUsed = new Map();
export function pickFallbackReply(_agentId, effect = "reply") {
  const list = FALLBACK_REPLIES[effect] || FALLBACK_REPLIES.reply;
  let used = fallbackUsed.get(effect);
  if (!used) {
    used = new Set();
    fallbackUsed.set(effect, used);
  }
  for (const text of list) {
    if (!used.has(text)) {
      used.add(text);
      return text;
    }
  }
  used.clear();
  used.add(list[0]);
  return list[0];
}

export function resetFallbackPickers() {
  fallbackUsed.clear();
}

export function cleanReplyText(value) {
  let text = typeof value === "string" ? value : "";
  text = text
    .replace(/<mood>[\s\S]*?<\/mood>/gi, "")
    .replace(/^```[\s\S]*?\n/, "")
    .replace(/```$/g, "")
    .replace(/^(回复|回答|台词)[:：]\s*/i, "")
    .trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("“") && text.endsWith("”"))) {
    text = text.slice(1, -1).trim();
  }
  return text.slice(0, 180);
}

export { FALLBACK_REPLIES, GENERIC_FALLBACK_STYLE };
