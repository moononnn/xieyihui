#!/usr/bin/env python3
"""歇一会 - 全屏强制休息窗口。

花招体系：
- 点击跳过必有文案回应（模型预生成 / 台词档案 / 本地兜底，按类型）
- 动作花招从抽签池随机叠加：move（按钮划走）/ extend（加时）/ stall（倒计时停滞）
- 抽签池一轮内不重复，用完洗牌，让每次点击都难以预料
- 按钮会追着鼠标逃（划走 3 次封顶），逃完就老实
- 休息完成时发结算请求，Node 返回夸夸与成就，窗口展示 2 秒后关闭
"""

import argparse
import json
import os
import random
import sys
import time
import uuid

from PyQt6.QtCore import QAbstractAnimation, QEvent, QPoint, QPointF, QPropertyAnimation, QSequentialAnimationGroup, QTimer, Qt, QEasingCurve, pyqtProperty
from PyQt6.QtGui import QBrush, QColor, QFont, QLinearGradient, QPainter, QPixmap, QCursor
from PyQt6.QtWidgets import (
    QApplication,
    QLabel,
    QProgressBar,
    QPushButton,
    QVBoxLayout,
    QWidget,
    QSizePolicy,
)

SUGGESTIONS = [
    "头慢慢画一个「米」字，活动僵硬的脖子",
    "右手扶左耳，头向右肩轻拉，换边重复",
    "双手背后十指相扣，慢慢上抬打开胸腔",
    "收紧下巴挤出双下巴，保持 5 秒再放松",
    "站起来踮起脚尖，保持 2 秒后缓缓落下",
    "向前向后慢慢转动肩膀，各画几个圈",
    "站起来走几步，看看窗外远处放松眼睛",
    "转转手腕和脚踝，每个方向转几圈",
]

INSTANT_FEEDBACK = [
    "我看见了，先把手放下。",
    "按钮可以点，休息也要算数。",
    "别急，给眼睛一点时间。",
    "先歇着，剩下的稍后再接着做。",
]
INSTANT_PICKER_INDEX = 0
INSTANT_USED = set()   # 本轮已用过的占位文案

# 花招参数
TRICK_ORDER = ("move", "extend", "stall", "confiscate")
BONUS_SECONDS_EARLY = (10, 15, 20)
BONUS_SECONDS_LATE = (15, 20, 30)   # 点击 >= 3 次后更狠
MAX_EXTRA_SECONDS = 120             # 本次窗口花招加时上限
EVADE_RADIUS = 150                  # 划走生效后，鼠标距离按钮中心这个范围内就触发逃跑
EVADE_POLL_MS = 90                  # 鼠标位置轮询间隔
EVADE_ANIM_MS = 150                 # 划走动画时长（要快，逃跑要果断）
EVADE_CHASE_S = 1.8                 # 抽中 move 后的追击窗口：这段时间鼠标靠近会再逃
EVADE_RETURN_MS = 1800              # 划走结束后多久滑回初始位置（别让用户等太久）
EVADE_COOLDOWN_S = 2.0              # 滑回后感应圈休眠多久，恢复窗口秩序
CONFISCATE_MS = 1500                # 按钮被没收的时长
STALL_CHOICES = (3, 4, 5)           # 倒计时停滞秒数
SETTLE_TIMEOUT_MS = 3500            # 等 Node 结算夸夸的最长时间
SETTLE_SHOW_MS = 2000               # 夸夸展示时长
TRIPLE_CLICK_WINDOW_S = 0.65        # 三击 emoji 逃生：相邻两次点击的间隔上限（放宽后 0.65s，正常手速三连击可达，慢慢点三下不算）

# 情绪 emoji（头像下方的小气泡）：按花招类型切换
EMOTION_DEFAULT = "😊"
EMOTIONS = {
    "move": "😤",
    "extend": "😏",
    "stall": "🤨",
    "confiscate": "🫣",
}


def pick_instant():
    """本地即时占位文案：本轮内不重复（4 条用完才允许循环，极端兜底）。"""
    global INSTANT_PICKER_INDEX, INSTANT_USED
    available = [t for t in INSTANT_FEEDBACK if t not in INSTANT_USED]
    if not available:
        INSTANT_USED.clear()
        available = list(INSTANT_FEEDBACK)
    item = available[INSTANT_PICKER_INDEX % len(available)]
    INSTANT_PICKER_INDEX += 1
    INSTANT_USED.add(item)
    return item


class TrickPool:
    """不重复抽签池：抽完一轮才洗牌重置。"""

    def __init__(self, items, rng=None):
        self.items = list(items)
        self.rng = rng or random
        self.pool = []
        self._refill()

    def _refill(self):
        self.pool = list(self.items)
        self.rng.shuffle(self.pool)

    def draw(self):
        if not self.items:
            return None
        if not self.pool:
            self._refill()
        return self.pool.pop()


class FullscreenOverlay(QWidget):
    def __init__(self, duration_sec, agent_name, agent_id, agent_avatar, force_mode,
                 ipc_dir="", debt_seconds=0, window_id="", rng=None):
        super().__init__()
        self._rng = rng or random   # 提前初始化，供下面的随机参数使用
        self.remaining = duration_sec
        self.total_seconds = duration_sec
        self.force_mode = force_mode
        self.skip_clicks = 0
        self.extra_seconds = 0
        self.button_evades = 0
        self.confiscates = 0   # 按钮被没收的次数（上报给 Node，用于“被没收还坚持”成就）
        # 一次 move 花招 = 主动逃一次 + 追击最多再逃一次，边界清晰不套路
        self.max_button_evades = 2
        self.debt_seconds = int(debt_seconds or 0)
        self.window_id = window_id or f"w-{int(time.time() * 1000)}"
        self.agent_id = agent_id
        self.ipc_dir = ipc_dir
        self.pending_ids = []
        self._settle_pending_id = None
        self._settle_wait_start = 0.0
        self._finished = False
        self._last_reply_error = False
        self._started_at = time.time()
        self._trick_pool = TrickPool(TRICK_ORDER, self._rng)
        self._evade_anim = None
        self._return_timer = None
        self._evade_active = False   # 只有第一次点击跳过后才开始躲避
        self._evade_chase_until = 0.0   # 追击窗口截止时间：只有抽中 move 后才进入追逃状态
        self._evade_cooldown_until = 0.0   # 滑回中心后的感应圈休眠截止时间
        self._confiscate_timer = None      # 按钮被没收的恢复定时器
        self._stall_timer = None
        self._stall_ticks = 0
        self._stall_total = 0
        self._flash_anim = None
        self._progress_flash = 0.0     # 进度条红色闪一下的强度
        self._triple_click_count = 0   # 三击 emoji 逃生出口的连击计数
        self._triple_click_last = 0.0

        screen = QApplication.primaryScreen()
        geometry = screen.availableGeometry() if screen else None
        self._screen_width = geometry.width() if geometry else 1280
        self._screen_height = geometry.height() if geometry else 800
        self._compact = self._screen_height < 760
        self._avatar_size = 150 if self._compact else 180
        self._avatar_inner_size = 116 if self._compact else 140
        print(f"[xieyihui-window] init force={self.force_mode} ipc={bool(self.ipc_dir)} "
              f"debt={self.debt_seconds} window={self.window_id}", file=sys.stderr, flush=True)

        self._flash_strength = 0.0

        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )

        self.avatar_container = QWidget(self)
        self.avatar_container.setFixedSize(self._avatar_size, self._avatar_size)
        self.avatar_container.setCursor(Qt.CursorShape.ArrowCursor)

        self.avatar_ring = QLabel(self.avatar_container)
        self.avatar_ring.setFixedSize(self._avatar_size, self._avatar_size)
        self.avatar_ring.setStyleSheet(
            f"QLabel {{ border: 3px solid rgba(45,90,77,0.30); "
            f"border-radius: {self._avatar_size // 2}px; background: transparent; }}"
        )
        self.avatar_ring.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)

        # 情绪 emoji 气泡：头像右下角的小表情，按花招类型切换
        self.emotion_bubble = QLabel(EMOTION_DEFAULT, self.avatar_container)
        self.emotion_bubble.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.emotion_bubble.setFont(QFont("Segoe UI Emoji", 20))
        bubble_size = 40
        self.emotion_bubble.setFixedSize(bubble_size, bubble_size)
        self.emotion_bubble.setStyleSheet(
            "QLabel { background: rgba(255,255,255,0.92); border: 2px solid rgba(45,90,77,0.35); "
            "border-radius: 20px; }"
        )
        # 完全放在容器内，右下角叠在头像边缘，不超出
        bubble_x = self._avatar_size - bubble_size - 2
        bubble_y = self._avatar_size - bubble_size - 2
        self.emotion_bubble.move(bubble_x, bubble_y)
        # 可点击：三击这里触发逃生出口
        self.emotion_bubble.installEventFilter(self)

        self.avatar = QLabel(self.avatar_container)
        self.avatar.setFixedSize(self._avatar_inner_size, self._avatar_inner_size)
        avatar_offset = (self._avatar_size - self._avatar_inner_size) // 2
        self.avatar.move(avatar_offset, avatar_offset)
        self.avatar.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        if agent_avatar:
            pix = QPixmap(agent_avatar)
            if not pix.isNull():
                self.avatar.setPixmap(self._make_circular(pix, self._avatar_inner_size))
                self.avatar.setStyleSheet(
                    f"border-radius: {self._avatar_inner_size // 2}px; background: transparent;"
                )
            else:
                self._set_avatar_fallback()
        else:
            self._set_avatar_fallback()

        self.msg = QLabel(f"{agent_name} 提醒你：该休息了", self)
        self.msg.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.msg.setTextFormat(Qt.TextFormat.PlainText)
        self.msg.setWordWrap(True)
        self.msg.setFixedWidth(min(860, max(360, self._screen_width - 80)))
        self.msg.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Minimum)
        self.msg.setFont(QFont("LXGW WenKai", 22 if self._compact else 24, QFont.Weight.Normal))
        self.msg.setStyleSheet("color: #2D5A4D; letter-spacing: 1px;")
        self._fit_label_height(self.msg)

        self.feedback = QLabel(random.choice(SUGGESTIONS), self)
        self.feedback.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.feedback.setTextFormat(Qt.TextFormat.PlainText)
        self.feedback.setWordWrap(True)
        self.feedback.setFixedWidth(min(760, max(320, self._screen_width - 120)))
        self.feedback.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Minimum)
        self.feedback.setFont(QFont("LXGW WenKai", 14 if self._compact else 15, QFont.Weight.Normal))
        self.feedback.setStyleSheet("color: rgba(45,90,77,0.72); padding: 4px 18px;")
        self._fit_label_height(self.feedback)

        self.timer_label = QLabel(self._fmt(self.remaining), self)
        self.timer_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.timer_label.setFont(QFont("Microsoft YaHei", 44 if self._compact else 52, QFont.Weight.ExtraLight))
        self.timer_label.setStyleSheet("color: #2D5A4D; letter-spacing: 3px;")

        # 休息进度条：剩余时间比例，随时间倒退，直观看到还要歇多久
        self.progress_bar = QProgressBar(self)
        self.progress_bar.setRange(0, 100)
        self.progress_bar.setValue(100)
        self.progress_bar.setTextVisible(False)
        self.progress_bar.setFixedWidth(min(420, max(280, self._screen_width - 160)))
        self.progress_bar.setFixedHeight(10)
        self.progress_bar.setStyleSheet(
            "QProgressBar { border: 1px solid rgba(45,90,77,0.35); border-radius: 5px; "
            "background: rgba(255,255,255,0.45); }"
            "QProgressBar::chunk { border-radius: 4px; background: #7FB5A0; }"
        )

        # 停滞提示：盖在倒计时上的红叉，让人一眼看出时间停了
        self.stall_overlay = QLabel("✕", self.timer_label)
        self.stall_overlay.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.stall_overlay.setFont(QFont("Segoe UI Symbol", 46 if not self._compact else 40, QFont.Weight.Bold))
        self.stall_overlay.setStyleSheet(
            "QLabel { color: rgba(224,48,48,0.88); background: rgba(255,255,255,0.30); border-radius: 10px; }"
        )
        self.stall_overlay.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self.stall_overlay.hide()

        stage_width = min(620, max(360, self._screen_width - 100))
        stage_height = 64 if self._compact else 76
        self.button_stage = QWidget(self)
        self.button_stage.setFixedSize(stage_width, stage_height)
        self.button_stage.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)

        self.btn_skip = QPushButton("跳过本次休息", self.button_stage)
        self.btn_skip.setStyleSheet(
            "QPushButton { border: 1px dashed rgba(45,90,77,0.32); border-radius: 12px; "
            "padding: 10px 34px; font-size: 16px; font-family: 'LXGW WenKai'; "
            "background: rgba(255,255,255,0.58); color: #2D5A4D; }"
            "QPushButton:hover { background: rgba(255,255,255,0.78); }"
            "QPushButton:pressed { background: rgba(255,238,238,0.90); color: #A54444; }"
        )
        self.btn_skip.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_skip.setMinimumWidth(190 if not self._compact else 170)
        self.btn_skip.setFixedHeight(48 if not self._compact else 44)
        self.btn_skip.installEventFilter(self)
        self.btn_skip.clicked.connect(self._on_skip)
        self._center_skip_button()

        self.main_layout = QVBoxLayout()
        self.main_layout.setContentsMargins(24, 18, 24, 18)
        self.main_layout.setSpacing(0)
        self.main_layout.addStretch(1)
        self.main_layout.addWidget(self.avatar_container, 0, Qt.AlignmentFlag.AlignCenter)
        self.main_layout.addSpacing(12 if self._compact else 24)
        self.main_layout.addWidget(self.msg, 0, Qt.AlignmentFlag.AlignCenter)
        self.main_layout.addSpacing(8)
        self.main_layout.addWidget(self.feedback, 0, Qt.AlignmentFlag.AlignCenter)
        self.main_layout.addSpacing(14 if self._compact else 24)
        self.main_layout.addWidget(self.timer_label, 0, Qt.AlignmentFlag.AlignCenter)
        self.main_layout.addSpacing(8)
        self.main_layout.addWidget(self.progress_bar, 0, Qt.AlignmentFlag.AlignCenter)
        self.main_layout.addSpacing(20 if self._compact else 30)
        self.main_layout.addWidget(self.button_stage, 0, Qt.AlignmentFlag.AlignCenter)
        self.main_layout.addStretch(1)
        self.setLayout(self.main_layout)

        self._countdown_timer = QTimer(self)
        self._countdown_timer.timeout.connect(self._tick)
        self._countdown_timer.start(1000)

        self._response_timer = QTimer(self)
        self._response_timer.timeout.connect(self._poll_responses)
        self._response_timer.start(120)

        self._evade_timer = QTimer(self)
        self._evade_timer.timeout.connect(self._check_evade)
        self._evade_timer.start(EVADE_POLL_MS)

        if self.debt_seconds > 0:
            # 欠账提示：只设置文本和最小高度，不做布局激活（init 阶段 activate 会触发 Qt 原生崩溃）
            self.feedback.setText(f"上次欠的 {self.debt_seconds} 秒，这次一起还")
            self.feedback.setStyleSheet("color: #845A52; font-weight: 600; padding: 4px 18px;")
            self._fit_label_height(self.feedback)

        self.showFullScreen()

    # ─── 按钮与花招 ───────────────────────────────

    def _center_skip_button(self):
        pos = self._center_pos()
        self.btn_skip.move(pos)

    def _center_pos(self):
        x = max(0, (self.button_stage.width() - self.btn_skip.width()) // 2)
        y = max(0, (self.button_stage.height() - self.btn_skip.height()) // 2)
        return QPoint(x, y)

    def _check_evade(self):
        """追击窗口内鼠标靠近按钮才划走（只有抽中 move 花招后进入追逃状态）"""
        if self._finished:
            return   # 结算期不再追逃，按钮安静等窗口关闭
        if not self.force_mode or not self._evade_active:
            return
        if time.time() >= self._evade_chase_until:
            return   # 不在追击窗口：按钮安稳，滑动不乱入
        if time.time() < self._evade_cooldown_until:
            return
        if self.button_evades >= self.max_button_evades:
            return
        if self._evade_anim is not None and self._evade_anim.state() == QAbstractAnimation.State.Running:
            return
        cursor = QCursor.pos()
        btn_center = self.btn_skip.mapToGlobal(self.btn_skip.rect().center())
        dx = cursor.x() - btn_center.x()
        dy = cursor.y() - btn_center.y()
        if dx * dx + dy * dy > EVADE_RADIUS * EVADE_RADIUS:
            return
        self._evade_once(cursor, chase=True)

    def _evade_once(self, cursor_pos, chase=False):
        """把按钮划到远离鼠标的随机位置（象限随机 + 落点随机），带动画。
        chase=True 表示这是追击窗口内的追加逃跑，文案会明说这是最后一次。"""
        stage = self.button_stage
        bw = self.btn_skip.width()
        bh = self.btn_skip.height()
        max_x = max(0, stage.width() - bw)
        max_y = max(0, stage.height() - bh)
        if max_x + max_y <= 0:
            return False
        # 停掉正在跑的滑回动画，避免两个动画同时控制位置
        if self._evade_anim is not None:
            state = self._evade_anim.state()
            if state in (QAbstractAnimation.State.Running, QAbstractAnimation.State.Paused):
                self._evade_anim.stop()
                self._evade_anim = None
        tl = stage.mapToGlobal(QPoint(0, 0))
        mx = cursor_pos.x() - tl.x()
        my = cursor_pos.y() - tl.y()
        # 四象限中心作为候选；排除鼠标所在象限，随机选一个，落点再随机
        quadrants = [
            (0.25, 0.25),   # 左上
            (0.75, 0.25),   # 右上
            (0.25, 0.75),   # 左下
            (0.75, 0.75),   # 右下
        ]
        mouse_quad = (0 if my < max_y / 2 else 1) * 2 + (0 if mx < max_x / 2 else 1)
        candidates = [i for i in range(4) if i != mouse_quad] or [mouse_quad]
        target = self._rng.choice(candidates)
        margin_x = max(0, int(bw * 0.35))
        margin_y = max(0, int(bh * 0.35))
        qx0 = target % 2
        qy0 = target // 2
        x0 = int(max_x * (qx0 * 0.5)) + margin_x
        x1 = int(max_x * (qx0 * 0.5 + 0.5)) - margin_x
        y0 = int(max_y * (qy0 * 0.5)) + margin_y
        y1 = int(max_y * (qy0 * 0.5 + 0.5)) - margin_y
        if x1 <= x0:
            x1 = max_x
        if y1 <= y0:
            y1 = max_y
        tx = self._rng.randint(min(x0, x1), max(x0, x1))
        ty = self._rng.randint(min(y0, y1), max(y0, y1))
        anim = QPropertyAnimation(self.btn_skip, b"pos", self)
        anim.setDuration(EVADE_ANIM_MS)
        anim.setStartValue(self.btn_skip.pos())
        anim.setEndValue(QPoint(int(tx), int(ty)))
        anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        anim.finished.connect(self._on_evade_finished)
        self._evade_anim = anim
        self._cancel_return_center()
        self.button_evades += 1
        self._set_agent_emotion("move")
        fallback = "还敢追？那就再跑一次给你看。" if chase else "按钮跑了，你先歇一下。"
        self._request_reply("move", fallback)
        if self.button_evades >= self.max_button_evades:
            self._evade_chase_until = 0.0   # 追加次数用完，追击结束，按钮此后稳定
        anim.start()
        return True

    def _on_evade_finished(self):
        self._evade_anim = None
        self._schedule_return_center()

    def _schedule_return_center(self):
        """划走结束后过一会儿自动滑回初始位置，保持窗口秩序。"""
        self._cancel_return_center()
        self._return_timer = QTimer(self)
        self._return_timer.setSingleShot(True)
        self._return_timer.timeout.connect(self._return_center)
        self._return_timer.start(EVADE_RETURN_MS)

    def _cancel_return_center(self):
        if self._return_timer is not None:
            self._return_timer.stop()
            self._return_timer = None

    def _return_center(self):
        """把按钮滑回初始居中位置，滑回后感应圈休眠两秒恢复秩序。"""
        self._return_timer = None
        if self._evade_anim is not None and self._evade_anim.state() == QAbstractAnimation.State.Running:
            return
        center = self._center_pos()
        if self.btn_skip.pos() == center:
            self._evade_cooldown_until = time.time() + EVADE_COOLDOWN_S
            return

        def on_return_done():
            self._evade_anim = None
            self._evade_cooldown_until = time.time() + EVADE_COOLDOWN_S

        anim = QPropertyAnimation(self.btn_skip, b"pos", self)
        anim.setDuration(300)
        anim.setStartValue(self.btn_skip.pos())
        anim.setEndValue(center)
        anim.setEasingCurve(QEasingCurve.Type.OutCubic)
        anim.finished.connect(on_return_done)
        self._evade_anim = anim
        anim.start()

    def _confiscate_button(self):
        """按钮被没收：停掉划走动画，消失一会儿，然后回到中心重新出现。"""
        if self._confiscate_timer is not None and self._confiscate_timer.isActive():
            return False
        self._cancel_return_center()
        if self._evade_anim is not None:
            self._evade_anim.stop()
            self._evade_anim = None
        self._evade_active = False   # 没收期间感应圈也休眠
        self._evade_chase_until = 0.0   # 清掉追击窗口
        self.confiscates += 1
        self.btn_skip.hide()
        self._confiscate_timer = QTimer(self)
        self._confiscate_timer.setSingleShot(True)
        self._confiscate_timer.timeout.connect(self._restore_button)
        self._confiscate_timer.start(CONFISCATE_MS)
        return True

    def _restore_button(self):
        """没收结束：按钮回到中心，重新出现。"""
        self._confiscate_timer = None
        self._center_skip_button()
        self.btn_skip.show()
        self._evade_active = True
        self._evade_cooldown_until = time.time() + EVADE_COOLDOWN_S

    def _set_agent_emotion(self, effect):
        """头像下的情绪 emoji 按花招类型切换，普通点击回默认。"""
        emoji = EMOTIONS.get(effect, EMOTION_DEFAULT)
        self.emotion_bubble.setText(emoji)

    def _flash_progress(self):
        """进度条倒退时闪一下红。"""
        self._progress_flash = 1.0
        self.progress_bar.setStyleSheet(
            "QProgressBar { border: 1px solid rgba(165,68,68,0.6); border-radius: 5px; "
            "background: rgba(255,255,255,0.45); }"
            "QProgressBar::chunk { border-radius: 4px; background: #D98291; }"
        )
        QTimer.singleShot(700, self._restore_progress_style)

    def _restore_progress_style(self):
        self._progress_flash = 0.0
        self.progress_bar.setStyleSheet(
            "QProgressBar { border: 1px solid rgba(45,90,77,0.35); border-radius: 5px; "
            "background: rgba(255,255,255,0.45); }"
            "QProgressBar::chunk { border-radius: 4px; background: #7FB5A0; }"
        )

    def _update_progress(self):
        # 分母包含已加时：加时后进度条按新总时长倒退，不会顶格卡住
        total = self.total_seconds + self.extra_seconds
        if total <= 0:
            return
        percent = max(0, min(100, int(self.remaining / total * 100)))
        self.progress_bar.setValue(percent)

    def _move_skip_button_on_click(self):
        """点击跳过的瞬间，按钮也划走一次（当作 move 花招），并进入追击窗口。"""
        if not self._evade_active:
            return False
        if self.button_evades >= self.max_button_evades:
            return False
        if self._evade_anim is not None and self._evade_anim.state() == QAbstractAnimation.State.Running:
            return False   # 划走动画运行中不打断，让动画完整演完，本次转普通文案
        self._evade_chase_until = time.time() + EVADE_CHASE_S
        return self._evade_once(QCursor.pos())

    def _add_bonus_time(self):
        remaining = MAX_EXTRA_SECONDS - self.extra_seconds
        if remaining <= 0:
            return 0
        choices = BONUS_SECONDS_LATE if self.skip_clicks >= 3 else BONUS_SECONDS_EARLY
        bonus = min(self._rng.choice(choices), remaining)
        self.extra_seconds += bonus
        self.remaining += bonus
        self.timer_label.setText(self._fmt(self.remaining))
        self._update_progress()
        self._flash_progress()
        return bonus

    def _stall_countdown(self):
        if self._stall_timer is not None and self._stall_timer.isActive():
            return
        self._countdown_timer.stop()
        self._stall_ticks = 0
        self._stall_total = self._rng.choice(STALL_CHOICES)
        self._stall_timer = QTimer(self)
        self._stall_timer.timeout.connect(self._stall_tick)
        self._stall_timer.start(1000)
        # 视觉盖章：红叉盖在数字上 + 数字变灰，一眼看出时间停了
        self.stall_overlay.setGeometry(0, 0, self.timer_label.width(), self.timer_label.height())
        self.stall_overlay.show()
        self.stall_overlay.raise_()
        self.timer_label.setStyleSheet("color: rgba(45,90,77,0.35); letter-spacing: 3px;")

    def _stall_tick(self):
        self._stall_ticks += 1
        if self._stall_ticks >= self._stall_total:
            self._stall_timer.stop()
            self.stall_overlay.hide()
            self.timer_label.setStyleSheet("color: #2D5A4D; letter-spacing: 3px;")
            if not self._finished:
                self._countdown_timer.start(1000)

    # ─── 点击跳过 ────────────────────────────────

    def _on_skip(self):
        if self._finished:
            return   # 结算期禁止交互：不覆盖已写好的 completed 结算，不触发花招
        print(f"[xieyihui-window] skip click force={self.force_mode}", file=sys.stderr, flush=True)
        if not self.force_mode:
            self.skip_clicks += 1
            self._write_summary("escaped")
            QApplication.exit(1)
            return
        # 划走动画运行中点击无效：按钮在跑，点到的都是空气
        if self._evade_anim is not None and self._evade_anim.state() == QAbstractAnimation.State.Running:
            return
        # 停滞期间点击无效：时间都停了，不许再叠花招
        if self._stall_timer is not None and self._stall_timer.isActive():
            return
        self.skip_clicks += 1
        if not self._evade_active:
            self._evade_active = True   # 第一次点击跳过后，花招正式开始
        # 点击会打断回中心，但如果按钮不在中心，停手后仍要归位
        self._cancel_return_center()
        if self.btn_skip.pos() != self._center_pos():
            self._schedule_return_center()
        self._start_flash()

        effect = self._trick_pool.draw() or "reply"
        if effect == "move":
            if self._move_skip_button_on_click():
                self._set_agent_emotion("move")
                return
            effect = "reply"
        if effect == "extend":
            bonus = self._add_bonus_time()
            if bonus:
                self._set_agent_emotion("extend")
                self._request_reply("extend", f"连续跳过 {self.skip_clicks} 次，休息时间加长 {bonus} 秒。")
                return
            effect = "reply"
        if effect == "stall":
            self._stall_countdown()
            self._set_agent_emotion("stall")
            self._request_reply("stall", f"倒计时停了 {self._stall_total} 秒，想跑也跑不掉。")
            return
        if effect == "confiscate":
            if self._confiscate_button():
                self._set_agent_emotion("confiscate")
                self._request_reply("confiscate", "按钮被我没收了，先好好歇着。")
                return
            effect = "reply"
        self._set_agent_emotion("reply")
        self._request_reply("reply", pick_instant())

    # ─── 文案与 IPC ──────────────────────────────

    def _request_reply(self, effect, fallback_text):
        self._show_reply(fallback_text)
        self._request_live_reply(effect)

    def _request_live_reply(self, effect):
        if not self.ipc_dir:
            return
        os.makedirs(self.ipc_dir, exist_ok=True)
        request_id = f"{int(time.time() * 1000)}-{self.skip_clicks}-{uuid.uuid4().hex[:8]}"
        payload = {
            "requestId": request_id,
            "clickCount": self.skip_clicks,
            "agentId": self.agent_id,
            "effect": effect,
            "createdAt": time.time(),
        }
        target = os.path.join(self.ipc_dir, f"request-{request_id}.json")
        temp = target + ".tmp"
        try:
            with open(temp, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False)
            os.replace(temp, target)
            self.pending_ids.append(request_id)
            self.feedback.setStyleSheet("color: rgba(45,90,77,0.62); font-weight: 400; padding: 4px 18px;")
        except OSError:
            try:
                os.unlink(temp)
            except OSError:
                pass
            self._show_reply("我这会儿没接到你的按钮，但你还是得歇着。", error=True)

    def _poll_responses(self):
        if self.ipc_dir:
            if self._settle_pending_id:
                self._check_settlement()
            if self.pending_ids:
                self._poll_live_responses()
        if not self._finished and self.remaining <= 0:
            self._finish_completed()

    def _poll_live_responses(self):
        for request_id in list(self.pending_ids):
            response_path = os.path.join(self.ipc_dir, f"response-{request_id}.json")
            if not os.path.exists(response_path):
                continue
            try:
                with open(response_path, "r", encoding="utf-8") as handle:
                    response = json.load(handle)
                text = str(response.get("text") or "").strip()
                if text:
                    self._show_reply(text, error=not bool(response.get("ok", True)))
            except (OSError, ValueError):
                self._show_reply("我听见你点了。先把手从按钮上拿开。", error=True)
            finally:
                try:
                    os.unlink(response_path)
                except OSError:
                    pass
                self.pending_ids.remove(request_id)

    # ─── 结算：休息完成 ─────────────────────────

    def _finish_completed(self):
        if self._finished:
            return
        self._finished = True
        self._write_summary("completed")
        if not self.ipc_dir:
            QApplication.exit(0)
            return
        request_id = f"{int(time.time() * 1000)}-settle-{uuid.uuid4().hex[:8]}"
        payload = {
            "requestId": request_id,
            "action": "completed",
            "windowId": self.window_id,
            "skips": self.skip_clicks,
            "evades": self.button_evades,
            "confiscates": self.confiscates,
            "extraSeconds": self.extra_seconds,
            "durationSec": self._elapsed_seconds(),
            "createdAt": time.time(),
        }
        target = os.path.join(self.ipc_dir, f"request-{request_id}.json")
        temp = target + ".tmp"
        try:
            with open(temp, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False)
            os.replace(temp, target)
            self._settle_pending_id = request_id
            self._settle_wait_start = time.time()
        except OSError:
            try:
                os.unlink(temp)
            except OSError:
                pass
            QApplication.exit(0)

    def _check_settlement(self):
        if not self._settle_pending_id:
            return
        response_path = os.path.join(self.ipc_dir, f"response-{self._settle_pending_id}.json")
        if os.path.exists(response_path):
            try:
                with open(response_path, "r", encoding="utf-8") as handle:
                    response = json.load(handle)
                text = str(response.get("text") or "").strip()
                if text:
                    self._show_reply(text, error=not bool(response.get("ok", True)))
            except (OSError, ValueError):
                pass
            try:
                os.unlink(response_path)
            except OSError:
                pass
            self._settle_pending_id = None
            QTimer.singleShot(SETTLE_SHOW_MS, lambda: QApplication.exit(0))
        elif time.time() - self._settle_wait_start > SETTLE_TIMEOUT_MS / 1000.0:
            self._settle_pending_id = None
            QApplication.exit(0)

    def _elapsed_seconds(self):
        return max(0, int(time.time() - self._started_at))

    def _write_summary(self, action):
        if not self.ipc_dir:
            return
        os.makedirs(self.ipc_dir, exist_ok=True)
        payload = {
            "windowId": self.window_id,
            "action": action,
            "skips": self.skip_clicks,
            "evades": self.button_evades,
            "confiscates": self.confiscates,
            "extraSeconds": self.extra_seconds,
            "durationSec": self._elapsed_seconds(),
            "struggle": action == "escaped" or self.skip_clicks > 0 or self.button_evades > 0,
        }
        target = os.path.join(self.ipc_dir, f"summary-{self.window_id}.json")
        temp = target + ".tmp"
        try:
            with open(temp, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False)
            os.replace(temp, target)
        except OSError:
            try:
                os.unlink(temp)
            except OSError:
                pass

    # ─── 视觉 ────────────────────────────────────

    def _get_flash_strength(self):
        return self._flash_strength

    def _set_flash_strength(self, value):
        self._flash_strength = max(0.0, min(1.0, float(value)))
        self.update()

    flashStrength = pyqtProperty(float, _get_flash_strength, _set_flash_strength)

    def _start_flash(self):
        """统一两下、慢速呼吸式的红光，像叹气。"""
        if self._flash_anim is not None and self._flash_anim.state() == QAbstractAnimation.State.Running:
            return
        self._flash_strength = 0.0
        group = QSequentialAnimationGroup(self)
        for _ in range(2):
            up = QPropertyAnimation(self, b"flashStrength", group)
            up.setDuration(420)
            up.setStartValue(0.0)
            up.setEndValue(1.0)
            up.setEasingCurve(QEasingCurve.Type.InOutSine)
            down = QPropertyAnimation(self, b"flashStrength", group)
            down.setDuration(650)
            down.setStartValue(1.0)
            down.setEndValue(0.0)
            down.setEasingCurve(QEasingCurve.Type.InOutSine)
            group.addAnimation(up)
            group.addAnimation(down)
        group.finished.connect(lambda: setattr(self, "_flash_anim", None))
        self._flash_anim = group
        group.start()

    def _tick(self):
        if self._finished:
            return
        self.remaining -= 1
        self.timer_label.setText(self._fmt(max(0, self.remaining)))
        self._update_progress()
        if self.remaining <= 0:
            self._countdown_timer.stop()
            self._finish_completed()

    def _make_circular(self, pix, size):
        pix = pix.scaled(
            size,
            size,
            Qt.AspectRatioMode.KeepAspectRatioByExpanding,
            Qt.TransformationMode.SmoothTransformation,
        )
        x = (pix.width() - size) // 2
        y = (pix.height() - size) // 2
        pix = pix.copy(x, y, size, size)
        mask = QPixmap(size, size)
        mask.fill(Qt.GlobalColor.transparent)
        painter = QPainter(mask)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setBrush(QColor(Qt.GlobalColor.black))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawEllipse(0, 0, size, size)
        painter.end()
        pix.setMask(mask.createMaskFromColor(Qt.GlobalColor.transparent, Qt.MaskMode.MaskInColor))
        return pix

    def _set_avatar_fallback(self):
        self.avatar.setText("🌸")
        self.avatar.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.avatar.setStyleSheet(
            f"QLabel {{ border-radius: {self._avatar_inner_size // 2}px; color: white; "
            f"font-size: {44 if self._compact else 56}px; background: #9BC8B5; }}"
        )

    @staticmethod
    def _fmt(seconds):
        return f"{seconds // 60:02d}:{seconds % 60:02d}"

    @staticmethod
    def _fit_label_height(label):
        """给可换行 QLabel 锁住当前文本所需的最小高度，避免被 QVBoxLayout 压成半行。"""
        label.updateGeometry()
        height = label.heightForWidth(label.width())
        if height <= 0:
            height = label.sizeHint().height()
        label.setMinimumHeight(max(1, height))
        return height

    def _show_reply(self, text, error=False):
        self._last_reply_error = bool(error)
        self.feedback.setText(str(text))
        self._fit_label_height(self.feedback)
        self.msg.updateGeometry()
        self.feedback.updateGeometry()
        self.main_layout.invalidate()
        # 不手动 activate：手动激活布局在此环境会触发 Qt6Core 原生崩溃（0xc0000409），
        # 交给事件循环的 LayoutRequest 自动重排，invalidate 后会自动生效。
        # setText 后立即量高可能拿到布局前的宽度，延迟到事件循环后再修正一次
        QTimer.singleShot(0, self._refit_reply_layout)

    def _refit_reply_layout(self):
        """延迟修正：布局稳定后按真实宽度重新计算高度，避免长文案被压。"""
        if self._finished:
            return
        self._fit_label_height(self.feedback)
        self._fit_label_height(self.msg)
        self.main_layout.invalidate()
        # 同样不手动 activate，交给事件循环自动重排
        color = "#845A52" if self._last_reply_error else "#2D5A4D"
        self.feedback.setStyleSheet(f"color: {color}; font-weight: 600; padding: 4px 18px;")

    def eventFilter(self, obj, event):
        # 逃生出口：三击情绪 emoji 直接退出休息窗口
        if self._finished:
            return super().eventFilter(obj, event)
        if obj == self.emotion_bubble and event.type() == QEvent.Type.MouseButtonPress:
            now = time.time()
            if now - self._triple_click_last < TRIPLE_CLICK_WINDOW_S:
                self._triple_click_count += 1
            else:
                self._triple_click_count = 1
            self._triple_click_last = now
            if self._triple_click_count >= 3:
                self._triple_click_count = 0
                self._escape()
            return True
        return super().eventFilter(obj, event)

    def _escape(self):
        """逃生出口：逃逸退出（记 summary，由 Node 结算）"""
        self._write_summary("escaped")
        QApplication.exit(1)

    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor("#C4E5D6"))

        soft_light = QLinearGradient(0, 0, self.width() * 0.55, self.height() * 0.55)
        soft_light.setColorAt(0, QColor(255, 255, 255, 45))
        soft_light.setColorAt(1, QColor(255, 255, 255, 0))
        painter.fillRect(self.rect(), QBrush(soft_light))

        if self._flash_strength > 0:
            self._draw_red_edge_glow(painter)
        painter.end()

    def _draw_red_edge_glow(self, painter):
        strength = self._flash_strength
        if strength <= 0:
            return
        depth = 58
        alpha = int(210 * strength)   # 呼吸渐变：强度决定透明度
        red = QColor(224, 48, 48, alpha)
        clear = QColor(224, 48, 48, 0)
        w, h = self.width(), self.height()

        top = QLinearGradient(QPointF(0, 0), QPointF(0, depth))
        top.setColorAt(0, red)
        top.setColorAt(1, clear)
        painter.fillRect(0, 0, w, depth, QBrush(top))

        bottom = QLinearGradient(QPointF(0, h), QPointF(0, h - depth))
        bottom.setColorAt(0, red)
        bottom.setColorAt(1, clear)
        painter.fillRect(0, h - depth, w, depth, QBrush(bottom))

        left = QLinearGradient(QPointF(0, 0), QPointF(depth, 0))
        left.setColorAt(0, red)
        left.setColorAt(1, clear)
        painter.fillRect(0, 0, depth, h, QBrush(left))

        right = QLinearGradient(QPointF(w, 0), QPointF(w - depth, 0))
        right.setColorAt(0, red)
        right.setColorAt(1, clear)
        painter.fillRect(w - depth, 0, depth, h, QBrush(right))

    def keyPressEvent(self, event):
        if self._finished:
            return   # 结算期按 Escape 不改变已写好的结算结果
        if not self.force_mode and event.key() == Qt.Key.Key_Escape:
            self._write_summary("escaped")
            QApplication.exit(1)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="歇一会 全屏休息窗口")
    parser.add_argument("--duration", type=int, default=20)
    parser.add_argument("--agent-name", default="当前助手")
    parser.add_argument("--agent-id", default="")
    parser.add_argument("--agent-avatar", default="")
    parser.add_argument("--ipc-dir", default="")
    parser.add_argument("--debt", type=int, default=0)
    parser.add_argument("--window-id", default="")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    app = QApplication(sys.argv)
    window = FullscreenOverlay(
        args.duration,
        args.agent_name,
        args.agent_id,
        args.agent_avatar,
        args.force,
        args.ipc_dir,
        args.debt,
        args.window_id,
    )
    window.show()
    sys.exit(app.exec())
