// サーバーと同じドメインから配信する場合は、このままで動きます。
// クライアントだけを別ドメイン（Cloudflare Pages など）に置く場合は、
// API_BASE にサーバーのURL（末尾の / なし）を入れてください。例: 'https://your-app.onrender.com'
window.APP_CONFIG = { API_BASE: '' };
