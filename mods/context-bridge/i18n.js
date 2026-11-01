export const catalogs = {
  en: {
    awaitingUsage: 'Waiting for usage after sign-in.',
    fiveHour: '5h', weekly: 'Week', openDetails: 'Open usage and handoff details', close: 'Close',
    unavailable: 'Unavailable', helperResponse: 'Unable to read helper response. Check the installation path.', helperFailed: 'Helper execution failed.',
    lowQuotaTitle: '{provider} quota is low', lowQuotaBody: '{window}: {remaining}% left · {action}', autoStarted: 'Automatic handoff started for registered sessions.', reviewPrompt: 'Review the session to hand off.',
    bindFirst: 'Connect a local source terminal and session first.', fresh: 'Current', stale: 'Outdated', remaining: '{remaining}% left', resetPending: 'Waiting for update after reset', resetAt: 'Resets {time}', noUsage: 'Usage has not been collected yet.', staleHint: 'Over 10 minutes old · excluded from auto handoff', updatedAt: 'Updated {time}', claudeStatusHint: 'Updates from the status line after a Claude response.',
    settings: 'Handoff settings', threshold: 'Remaining quota threshold: {threshold}%', modeAsk: 'Ask every time', modeAuto: 'Auto handoff for selected session', autoHint: 'Auto handoff uses the destination saved when you register each source session.', autoArmed: 'Auto ready · {key} → {target}', disarm: 'Remove', chooseTarget: 'Select target provider',
    handoffPermissions: 'Handoff target permissions', handoffPermissionDefault: 'Default permissions', handoffPermissionBypass: 'Skip permission checks', agyPermissionHint: 'AGY’s official status line does not report the current permission mode. Choose the target permissions for this source session directly.',
    sourcePicker: 'Source terminal and session', openTerminal: 'Open a local Claude Code, Codex or AGY terminal.', findingSessions: 'Finding sessions in the same folder…', noSessions: 'No sessions found. Check CLI sign-in, session history and hook settings.',
    jobPreparing: 'Preparing handoff records…', jobLaunched: 'Target terminal opened', jobFailed: 'Handoff failed', jobConfirm: 'Check the first prompt and record reading in the new terminal.', jobPreserving: 'Preserving source records.',
    reviewTitle: 'Confirm context handoff', refreshing: 'Refreshing…', refresh: 'Refresh', loadingUsage: 'Reading account usage…', usageFailed: 'Usage unavailable. Refresh to try again.', terminalError: 'Check terminal connection: {error}', sourceSelected: 'Source · {provider} {id}', chooseSource: 'Select source session',
    sourceSession: 'Source session: {id}', workingFolder: 'Working folder: {cwd}', targetQuota: 'Target quota: {state}', targetFresh: 'Current data available', targetCheck: 'Check needed', recordsHint: 'Available conversation and tool records, summaries and Git state are saved locally. The preserved scope depends on the source CLI. Running processes and internal model state are not copied.', sourceHint: 'The source is kept. Check that the target read the full record in the new terminal.', cliMissing: '{provider} CLI is not installed.', accountHint: 'Current local account · refreshes every 60s', later: 'Later', processing: 'Processing…', handoff: 'Hand off', manualReview: 'Confirm manual handoff',
  },
  ko: {
    awaitingUsage: '로그인 후 사용량을 기다리는 중입니다.',
    fiveHour: '5시간', weekly: '주간', openDetails: '사용량과 인계 상세 열기', close: '닫기',
    unavailable: '확인 불가', helperResponse: 'helper 응답을 읽을 수 없습니다. 설치 경로를 확인해 주세요.', helperFailed: 'helper 실행에 실패했습니다.',
    lowQuotaTitle: '{provider} 잔여량이 부족합니다', lowQuotaBody: '{window}: {remaining}% 남음 · {action}', autoStarted: '등록한 세션의 자동 인계를 시작했습니다.', reviewPrompt: '인계할 세션을 확인해 주세요.',
    bindFirst: '로컬 원본 터미널과 세션을 먼저 연결해 주세요.', fresh: '최신', stale: '오래된 정보', remaining: '{remaining}% 남음', resetPending: '리셋 후 갱신 대기', resetAt: '리셋 {time}', noUsage: '사용량이 아직 수집되지 않았습니다.', staleHint: '10분 이상 지난 수치 · 자동 인계에 사용하지 않음', updatedAt: '갱신 {time}', claudeStatusHint: 'Claude 응답 후 상태줄에서 갱신됩니다.',
    settings: '인계 설정', threshold: '잔여량 기준 {threshold}%', modeAsk: '매번 승인', modeAuto: '선택 세션 자동 인계', autoHint: '자동 인계는 직접 등록한 원본 세션과 등록할 때 저장한 대상에만 적용됩니다.', autoArmed: '자동 대기 · {key} → {target}', disarm: '해제', chooseTarget: '대상 제공자 선택',
    handoffPermissions: '인계 대상 권한', handoffPermissionDefault: '기본 권한', handoffPermissionBypass: '권한 확인 생략', agyPermissionHint: 'AGY 공식 상태줄은 현재 권한 모드를 제공하지 않습니다. 이 원본 세션에서 인계할 대상의 권한을 직접 선택해 주세요.',
    sourcePicker: '원본 터미널과 세션', openTerminal: '로컬 Claude Code, Codex 또는 AGY 터미널을 열어 주세요.', findingSessions: '같은 작업 폴더의 세션을 찾는 중…', noSessions: '후보 세션이 없습니다. CLI 로그인, 세션 기록과 hook 설정을 확인해 주세요.',
    jobPreparing: '인계 기록 준비 중…', jobLaunched: '대상 터미널 실행됨', jobFailed: '인계 실패', jobConfirm: '새 터미널에서 첫 프롬프트 전달과 기록 읽기를 확인해 주세요.', jobPreserving: '원본 기록을 보존하고 있습니다.',
    reviewTitle: '컨텍스트 인계 확인', refreshing: '갱신 중…', refresh: '새로고침', loadingUsage: '계정 사용량을 읽는 중…', usageFailed: '사용량을 확인할 수 없습니다. 새로고침으로 다시 시도해 주세요.', terminalError: '터미널 연결 확인 필요: {error}', sourceSelected: '원본 · {provider} {id}', chooseSource: '원본 세션 선택',
    sourceSession: '원본 세션: {id}', workingFolder: '작업 폴더: {cwd}', targetQuota: '대상 잔여량: {state}', targetFresh: '최신 수치 있음', targetCheck: '확인 필요', recordsHint: '확인할 수 있는 대화·도구 기록·압축 요약·Git 상태를 로컬 파일로 보존합니다. 보존 범위는 원본 CLI에 따라 다릅니다. 실행 중 프로세스와 모델 내부 상태는 복제되지 않습니다.', sourceHint: '원본은 유지됩니다. 대상이 전체 기록을 읽었는지는 새 터미널에서 확인해 주세요.', cliMissing: '{provider} CLI가 설치되어 있지 않습니다.', accountHint: '현재 로컬 로그인 계정 · 60초마다 갱신', later: '나중에', processing: '처리 중…', handoff: '인계하기', manualReview: '수동 인계 확인',
  },
  ja: {
    awaitingUsage: 'ログイン後の使用量を待っています。',
    fiveHour: '5時間', weekly: '週間', openDetails: '使用量と引き継ぎの詳細を開く', close: '閉じる',
    unavailable: '確認不可', helperResponse: 'ヘルパーの応答を読み取れません。インストール先を確認してください。', helperFailed: 'ヘルパーの実行に失敗しました。',
    lowQuotaTitle: '{provider} の残量が少なくなっています', lowQuotaBody: '{window}: 残り {remaining}% · {action}', autoStarted: '登録セッションの自動引き継ぎを開始しました。', reviewPrompt: '引き継ぐセッションを確認してください。',
    bindFirst: 'ローカルの元ターミナルとセッションを接続してください。', fresh: '最新', stale: '古い情報', remaining: '残り {remaining}%', resetPending: 'リセット後の更新待ち', resetAt: 'リセット {time}', noUsage: '使用量はまだ収集されていません。', staleHint: '10分以上経過 · 自動引き継ぎに不使用', updatedAt: '更新 {time}', claudeStatusHint: 'Claude の応答後にステータスラインから更新されます。',
    settings: '引き継ぎ設定', threshold: '残量の基準 {threshold}%', modeAsk: '毎回承認', modeAuto: '選択セッションを自動引き継ぎ', autoHint: '自動引き継ぎは、自分で登録した元セッションと登録時に保存した引き継ぎ先にのみ適用されます。', autoArmed: '自動待機 · {key} → {target}', disarm: '解除', chooseTarget: '引き継ぎ先を選択',
    handoffPermissions: '引き継ぎ先の権限', handoffPermissionDefault: '既定の権限', handoffPermissionBypass: '権限確認を省略', agyPermissionHint: 'AGY の公式ステータスラインは現在の権限モードを提供しません。この元セッションの引き継ぎ先の権限を直接選択してください。',
    sourcePicker: '元ターミナルとセッション', openTerminal: 'ローカルの Claude Code、Codex または AGY ターミナルを開いてください。', findingSessions: '同じフォルダーのセッションを検索中…', noSessions: '候補がありません。CLI のログイン、セッション履歴、フック設定を確認してください。',
    jobPreparing: '引き継ぎ記録を準備中…', jobLaunched: '対象ターミナルを起動しました', jobFailed: '引き継ぎ失敗', jobConfirm: '新しいターミナルで最初のプロンプトと記録の読み取りを確認してください。', jobPreserving: '元の記録を保存しています。',
    reviewTitle: 'コンテキスト引き継ぎの確認', refreshing: '更新中…', refresh: '更新', loadingUsage: 'アカウント使用量を読み込み中…', usageFailed: '使用量を確認できません。更新して再試行してください。', terminalError: 'ターミナルの接続を確認: {error}', sourceSelected: '引き継ぎ元 · {provider} {id}', chooseSource: '元セッションを選択',
    sourceSession: '元セッション: {id}', workingFolder: '作業フォルダー: {cwd}', targetQuota: '対象の残量: {state}', targetFresh: '最新データあり', targetCheck: '要確認', recordsHint: '取得できる会話・ツール記録・圧縮要約・Git 状態をローカルに保存します。保存範囲は元の CLI によって異なります。実行中のプロセスとモデルの内部状態は複製されません。', sourceHint: '元セッションは保持されます。全記録の読み取りは新しいターミナルで確認してください。', cliMissing: '{provider} CLI がインストールされていません。', accountHint: '現在のローカルアカウント · 60秒ごとに更新', later: '後で', processing: '処理中…', handoff: '引き継ぐ', manualReview: '手動引き継ぎを確認',
  },
  'zh-CN': {
    awaitingUsage: '正在等待登录后的用量。',
    fiveHour: '5小时', weekly: '每周', openDetails: '打开用量和交接详情', close: '关闭',
    unavailable: '无法确认', helperResponse: '无法读取辅助程序响应。请检查安装路径。', helperFailed: '辅助程序执行失败。',
    lowQuotaTitle: '{provider} 剩余额度不足', lowQuotaBody: '{window}: 剩余 {remaining}% · {action}', autoStarted: '已开始自动交接已注册的会话。', reviewPrompt: '请确认要交接的会话。',
    bindFirst: '请先连接本地来源终端和会话。', fresh: '最新', stale: '已过期', remaining: '剩余 {remaining}%', resetPending: '重置后等待更新', resetAt: '重置 {time}', noUsage: '尚未收集用量。', staleHint: '超过10分钟 · 不用于自动交接', updatedAt: '更新 {time}', claudeStatusHint: 'Claude 回复后通过状态栏更新。',
    settings: '交接设置', threshold: '剩余额度阈值 {threshold}%', modeAsk: '每次批准', modeAuto: '自动交接所选会话', autoHint: '自动交接仅适用于您手动注册的来源会话及注册时保存的目标。', autoArmed: '自动待命 · {key} → {target}', disarm: '解除', chooseTarget: '选择目标提供方',
    handoffPermissions: '交接目标权限', handoffPermissionDefault: '默认权限', handoffPermissionBypass: '跳过权限确认', agyPermissionHint: 'AGY 官方状态栏不提供当前权限模式。请直接选择此来源会话的交接目标权限。',
    sourcePicker: '来源终端和会话', openTerminal: '请打开本地 Claude Code、Codex 或 AGY 终端。', findingSessions: '正在查找同一目录下的会话…', noSessions: '未找到候选会话。请检查 CLI 登录、会话历史和钩子设置。',
    jobPreparing: '正在准备交接记录…', jobLaunched: '已启动目标终端', jobFailed: '交接失败', jobConfirm: '请在新终端中确认首条提示的发送和记录的读取。', jobPreserving: '正在保存来源记录。',
    reviewTitle: '确认上下文交接', refreshing: '正在更新…', refresh: '刷新', loadingUsage: '正在读取账户用量…', usageFailed: '无法获取用量。请刷新重试。', terminalError: '请检查终端连接: {error}', sourceSelected: '来源 · {provider} {id}', chooseSource: '选择来源会话',
    sourceSession: '来源会话: {id}', workingFolder: '工作目录: {cwd}', targetQuota: '目标剩余额度: {state}', targetFresh: '有最新数据', targetCheck: '需要确认', recordsHint: '可获取的对话、工具记录、压缩摘要和 Git 状态将保存为本地文件。保存范围取决于来源 CLI。运行中的进程和模型内部状态不会被复制。', sourceHint: '来源会话将保留。请在新终端中确认目标是否已读取全部记录。', cliMissing: '未安装 {provider} CLI。', accountHint: '当前本地登录账户 · 每60秒更新', later: '稍后', processing: '正在处理…', handoff: '交接', manualReview: '确认手动交接',
  },
};

export const uiLocale = (locale) => Object.hasOwn(catalogs, locale) ? locale : 'en';

export function translate(locale, key, values = {}) {
  const template = catalogs[uiLocale(locale)][key] ?? catalogs.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (placeholder, name) => values[name] === undefined ? placeholder : String(values[name]));
}

export function formatStamp(locale, time) {
  if (!Number.isFinite(time) || time <= 0) return translate(locale, 'unavailable');
  const tag = { en: 'en-US', ko: 'ko-KR', ja: 'ja-JP', 'zh-CN': 'zh-CN' }[uiLocale(locale)];
  return new Date(time).toLocaleString(tag, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
