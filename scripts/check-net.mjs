// 网络可达性检测：在启动项目前先运行  npm run check-net
// 任何一项失败都不影响程序启动，但对应功能会降级。

const TARGETS = [
  {
    name: 'Cesium ion 接口（地形/影像鉴权）',
    url: 'https://api.cesium.com/'
  },
  {
    name: 'Cesium ion 瓦片资产（地形/影像数据）',
    url: 'https://assets.ion.cesium.com/'
  },
  {
    name: 'Celestrak（天宫 TLE 实时轨道数据）',
    url: 'https://celestrak.org/NORAD/elements/gp.php?CATNR=48274&FORMAT=TLE',
    // 仅 HTTP 200 不够：参数写错时也会返回 200 + "Invalid query" 文本
    mustContain: '2 48274'
  },
  {
    name: 'USGS 天文地质中心（未来月球数据）',
    url: 'https://astrogeology.usgs.gov/'
  }
];

const TIMEOUT_MS = 8000;

async function check(target) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(target.url, {
      signal: ctrl.signal,
      // Celestrak 对 HEAD 支持不稳定，统一用 GET
      method: 'GET'
    });
    clearTimeout(timer);
    // 只要拿到了任何 HTTP 状态码（含 401/403/405），都说明网络可达：
    // 这些服务的根路径本来就不允许直接 GET，拒绝是正常响应。
    if (target.mustContain) {
      const body = await res.text();
      const valid = body.includes(target.mustContain);
      return {
        ok: valid,
        detail: valid
          ? `HTTP ${res.status}，内容校验通过，${Date.now() - started} ms`
          : `HTTP ${res.status} 但内容不是预期数据（${body.slice(0, 60).trim()}）`
      };
    }
    return {
      ok: true,
      detail: `HTTP ${res.status}（可达），${Date.now() - started} ms`
    };
  } catch (err) {
    clearTimeout(timer);
    return {
      ok: false,
      detail: err.name === 'AbortError' ? `超时（>${TIMEOUT_MS / 1000}s）` : err.message
    };
  }
}

console.log('正在检测网络连通性（约需几秒）...\n');
let failed = 0;
for (const target of TARGETS) {
  const result = await check(target);
  if (!result.ok) failed++;
  console.log(`${result.ok ? '✅ 可达' : '❌ 不通'}  ${target.name}`);
  console.log(`         ${target.url}`);
  console.log(`         ${result.detail}\n`);
}

if (failed > 0) {
  console.log(`结论：${failed} 个端点不通。程序仍可启动，但相关功能会降级（见界面提示）。`);
  console.log('常见原因：公司/校园网络拦截、需要代理。配置系统代理后重试即可。');
  process.exitCode = 0; // 不作为构建失败
} else {
  console.log('结论：全部可达，可以运行  npm run dev');
}
