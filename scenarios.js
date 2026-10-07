'use strict';
/**
 * シナリオ一覧（カタログ）。新しいシナリオは、ここに登録します。
 * 各エントリは resolve(人数) で「その人数用のシナリオ本体」を返します。
 *   - 深夜0時の館 : 既存シナリオ（3〜5人。足りない役はNPC）
 *   - 消えた魔女の遺産 : 4人版 / 5人版を人数で自動選択
 */
const midnight = require('./scenario');
const witch = require('./scenario-witch');

const DEFAULT_PHASES = ['lobby', 'character', 'opening', 'personal', 'info', 'discussion', 'extra', 'final', 'vote', 'result'];
const DEFAULT_LABELS = {
  lobby: 'ロビー',
  character: 'キャラクター決定',
  opening: 'オープニング',
  personal: '個人情報確認',
  info: '情報公開',
  discussion: '議論',
  extra: '追加情報',
  discussion2: '第二議論',
  final: '最終議論',
  vote: '投票',
  result: '結果発表'
};
const DEFAULT_DURATIONS = {
  character: 60,
  opening: 60,
  personal: 180,
  info: 300,
  discussion: 600,
  extra: 180,
  discussion2: 480,
  final: 300,
  vote: 60
};

const CATALOG = [
  {
    id: midnight.id,
    title: midnight.title,
    subtitle: midnight.subtitle,
    genre: '本格ミステリー',
    description: '現在の既存シナリオ。3〜5人用（5人未満なら余った役はNPC）。',
    minPlayers: midnight.minPlayers,
    maxPlayers: midnight.maxPlayers,
    phases: DEFAULT_PHASES,
    phaseLabels: DEFAULT_LABELS,
    defaultDurations: DEFAULT_DURATIONS,
    resolve: () => midnight
  },
  witch
];

function getEntry(id) {
  return CATALOG.find((s) => s.id === id) || null;
}

module.exports = { CATALOG, getEntry, DEFAULT_PHASES, DEFAULT_LABELS, DEFAULT_DURATIONS, DEFAULT_ID: midnight.id };
