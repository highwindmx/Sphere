// src/icons.js — 探月任务飞行器各阶段图标（billboard data URI，始终面向屏幕）
// 形态随分离事件同步：全箭（4 助推 + 整流罩）→ 芯级（整流罩仍在）→ 上面级/飞船（复用 moon-landing.js 的 SPACECRAFT_ICON）

function svg(inner) {
  return (
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' + inner + '</svg>'
    )
  );
}

// 完整长征五号：尖锥整流罩 + 白色芯级 + 4 枚蓝色助推器 + 红色尾焰
export const FULL_ROCKET_ICON = svg(
  '<path d="M12 1.6l2.5 4.4H9.5z" fill="#d4a04a"/>' +
  '<rect x="10.1" y="6" width="3.8" height="12.4" rx="0.6" fill="#e7ecf7"/>' +
  '<rect x="4.0" y="9.4" width="2.3" height="8.6" rx="0.8" fill="#6b7a9e"/>' +
  '<rect x="7.1" y="8.2" width="2.3" height="9.8" rx="0.8" fill="#8b98b8"/>' +
  '<rect x="14.6" y="8.2" width="2.3" height="9.8" rx="0.8" fill="#8b98b8"/>' +
  '<rect x="17.7" y="9.4" width="2.3" height="8.6" rx="0.8" fill="#6b7a9e"/>' +
  '<path d="M10.4 18.4h3.2l-1.6 4.2z" fill="#ff6b6b"/>' +
  '<path d="M4.4 18h1.5l-0.5 2.8zM18.1 18h1.5l0.5 2.8z" fill="#ff8a5c"/>'
);

// 助推器分离后：整流罩 + 芯级（无助推）
export const STAGE1_ICON = svg(
  '<path d="M12 1.6l2.5 4.4H9.5z" fill="#d4a04a"/>' +
  '<rect x="10.1" y="6" width="3.8" height="12.4" rx="0.6" fill="#e7ecf7"/>' +
  '<path d="M10.4 18.4h3.2l-1.6 4.2z" fill="#ff6b6b"/>'
);

// 单枚助推器（分离件）：白色柱体 + 金色尖头 + 红尾
export const BOOSTER_ICON = svg(
  '<path d="M12 3l2 3.6h-4z" fill="#d4a04a"/>' +
  '<rect x="9.6" y="6.6" width="4.8" height="11" rx="0.9" fill="#e7ecf7"/>' +
  '<rect x="9.6" y="11" width="4.8" height="1.6" fill="#6b7a9e"/>' +
  '<path d="M9.9 17.6h4.2l-2.1 3.8z" fill="#ff6b6b"/>'
);

// 整流罩左半瓣 / 右半瓣（分离件，向箭体两侧抛离）
export const FAIRING_LEFT_ICON = svg(
  '<path d="M12 2.4C7.6 6.6 7.4 14.6 12 20.4L12 2.4z" fill="#cdd8f2" stroke="#8b98b8" stroke-width="0.8"/>'
);
export const FAIRING_RIGHT_ICON = svg(
  '<path d="M12 2.4C16.4 6.6 16.6 14.6 12 20.4L12 2.4z" fill="#cdd8f2" stroke="#8b98b8" stroke-width="0.8"/>'
);

// 示意月球（地月转移顶视图中的目标点，距离已压缩）
export const MOON_ICON = svg(
  '<circle cx="12" cy="12" r="8.6" fill="#c9cdd6"/>' +
  '<circle cx="9.2" cy="9" r="1.7" fill="#9ba1ad"/>' +
  '<circle cx="14.8" cy="13.4" r="2.3" fill="#9ba1ad"/>' +
  '<circle cx="10.6" cy="15.6" r="1.1" fill="#9ba1ad"/>'
);

// 鹊桥中继星（2026-10-24）：星体 + 伞状高增益天线 + 金色太阳能翼
export const RELAY_ICON = svg(
  '<ellipse cx="12" cy="9.2" rx="7.0" ry="4.4" fill="#e6e9f2" stroke="#8b98b8" stroke-width="0.7"/>' +
  '<circle cx="12" cy="9.2" r="1.5" fill="#9aa4bd"/>' +
  '<rect x="10.6" y="11.2" width="2.8" height="5.2" rx="0.7" fill="#dfe4f0" stroke="#8b98b8" stroke-width="0.6"/>' +
  '<path d="M3.0 17.6h5.4v2.2H3.0zM15.6 17.6h5.4v2.2h-5.4z" fill="#c9a34e"/>'
);

// 玉兔号月球车（2026-10-24 修「焦点按钮图标不显示」）：六轮车体 + 金色太阳能阵 + 桅杆相机
export const ROVER_ICON = svg(
  '<rect x="7.4" y="10" width="9.2" height="4.4" rx="1" fill="#e7ecf7" stroke="#8b98b8" stroke-width="0.6"/>' +
  '<rect x="8.4" y="7.0" width="7.2" height="2.7" rx="0.5" fill="#c9a34e"/>' +
  '<rect x="11.5" y="4.4" width="1.5" height="3" rx="0.4" fill="#9aa4bd"/>' +
  '<rect x="10.6" y="3.0" width="3.0" height="1.9" rx="0.4" fill="#6b7a9e"/>' +
  '<circle cx="9" cy="15.4" r="2.1" fill="#3a4256"/>' +
  '<circle cx="12" cy="15.4" r="2.1" fill="#3a4256"/>' +
  '<circle cx="15" cy="15.4" r="2.1" fill="#3a4256"/>'
);

// 地球（焦点按钮用，与月背中继取景同源）
export const EARTH_ICON = svg(
  '<circle cx="12" cy="12" r="8.6" fill="#4a90d9"/>' +
  '<path d="M6 9.4c2.5-1 4.6 0.5 7 0.2s4 1.7 4.6 3.4c-2 .4-4-0.6-6 .2s-3.7 1.8-5.6 1.2z" fill="#5cb85c"/>' +
  '<circle cx="9" cy="8.8" r="1.4" fill="#5cb85c"/>' +
  '<circle cx="14.6" cy="15" r="1.9" fill="#5cb85c"/>'
);

export default {
  FULL_ROCKET_ICON,
  STAGE1_ICON,
  BOOSTER_ICON,
  FAIRING_LEFT_ICON,
  FAIRING_RIGHT_ICON,
  MOON_ICON,
  RELAY_ICON,
  ROVER_ICON,
  EARTH_ICON,
};