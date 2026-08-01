#!/usr/bin/env python3
"""歇一会 PyQt 最小回归测试：抽签池、花招、结算链路。"""

import json
import os
import random
import tempfile
import time

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PyQt6.QtWidgets import QApplication
from PyQt6.QtCore import QAbstractAnimation, QPoint, Qt
from PyQt6.QtTest import QTest
from fullscreen_test import (
    FullscreenOverlay,
    MAX_EXTRA_SECONDS,
    TrickPool,
)

# 1. 抽签池一轮内不重复
rng = random.Random(42)
pool = TrickPool(("move", "extend", "stall", "confiscate"), rng)
drawn = [pool.draw(), pool.draw(), pool.draw(), pool.draw()]
assert len(set(drawn)) == 4, f"抽签池一轮内重复：{drawn}"
assert pool.draw() in ("move", "extend", "stall", "confiscate"), "用完一轮应重新洗牌"
assert TrickPool([], rng).draw() is None, "空池应返回 None"

app = QApplication.instance() or QApplication([])
with tempfile.TemporaryDirectory() as ipc_dir:
    window = FullscreenOverlay(8, "助手甲", "agent-a", "", True, ipc_dir,
                               debt_seconds=30, window_id="w-self-test",
                               rng=random.Random(42))
    app.processEvents()

    # 欠账提示显示
    assert "30" in window.feedback.text(), f"欠账提示未显示：{window.feedback.text()}"

    # 划走次数固定 2 次：主动逃 1 次 + 追击最多再逃 1 次，边界清晰
    assert window.max_button_evades == 2, f"划走次数应固定 2 次：{window.max_button_evades}"

    # 追击窗口初始关闭：不抽中 move 时按钮不乱跑
    assert window._evade_chase_until == 0.0, "初始不应有追击窗口"

    # 情绪气泡完全在头像容器内
    bubble_geo = window.emotion_bubble.geometry()
    assert bubble_geo.left() >= 0 and bubble_geo.top() >= 0, "气泡不应超出容器左上"
    assert bubble_geo.right() <= window._avatar_size and bubble_geo.bottom() <= window._avatar_size, "气泡不应超出容器右下"

    # 开场不躲避：还没点击跳过，感应器不生效
    assert window._evade_active is False, "开场时躲避不应激活"
    assert not window._move_skip_button_on_click(), "开场时不应能触发划走"

    # 提醒文案高度
    msg_height = window.msg.heightForWidth(window.msg.width())
    assert window.msg.minimumHeight() >= max(1, msg_height), "助手提醒文案没有保留完整高度"

    # 第一次点击：激活躲避，命中某个花招，IPC 带 effect，且不重复
    window._trick_pool = TrickPool(("stall", "move", "extend", "confiscate"), window._rng)
    window._on_skip()
    app.processEvents()
    assert window._evade_active is True, "第一次点击后躲避应激活"
    assert window._flash_anim is not None and window._flash_anim.state() == QAbstractAnimation.State.Running, "呼吸式红光没有启动"
    assert window.skip_clicks == 1

    requests = [name for name in os.listdir(ipc_dir) if name.startswith("request-") and name.endswith(".json")]
    assert len(requests) == 1, f"预期 1 个实时回复请求，实际 {requests}"
    with open(os.path.join(ipc_dir, requests[0]), "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    assert payload["clickCount"] == 1
    assert payload["agentId"] == "agent-a"
    effect1 = payload["effect"]
    assert effect1 in ("stall", "move", "extend", "confiscate"), f"花招类型非法：{effect1}"
    if effect1 == "stall":
        assert not window._countdown_timer.isActive(), "停滞时倒计时应该暂停"
    elif effect1 == "move":
        assert window.button_evades >= 1, "move 花招应触发划走"
    else:
        assert window.extra_seconds > 0, "extend 花招应增加时长"

    # 配合花招时序：move 动画运行中 / stall 停滞期间点击会被忽略（设计行为），
    # 先让第一次点击的花招收尾，第二次点击才能正常计数
    if effect1 == "move":
        QTest.qWait(250)   # 等划走动画（150ms）跑完
    elif effect1 == "stall":
        window._stall_ticks = window._stall_total
        window._stall_tick()   # 立即结束停滞

    # 第二次点击：花招不重复（抽签池一轮内）
    window._on_skip()
    app.processEvents()
    assert window.skip_clicks == 2
    requests2 = [name for name in os.listdir(ipc_dir) if name.startswith("request-") and name.endswith(".json")]
    assert len(requests2) == 2, f"预期 2 个实时回复请求，实际 {requests2}"
    with open(os.path.join(ipc_dir, requests2[1]), "r", encoding="utf-8") as handle:
        payload2 = json.load(handle)
    assert payload2["effect"] != effect1, f"抽签池一轮内不应重复：{effect1}"

    # 情绪 emoji 与进度条
    assert window.emotion_bubble.text() in ("😊", "😤", "😏", "🤨", "🫣"), "情绪气泡应有合法 emoji"
    assert window.progress_bar is not None, "应有休息进度条"
    window._update_progress()
    assert 0 <= window.progress_bar.value() <= 100, "进度条应在 0~100 之间"
    window._set_agent_emotion("confiscate")
    assert window.emotion_bubble.text() == "🫣", "没收时情绪应切换为 🫣"
    window._set_agent_emotion("reply")
    assert window.emotion_bubble.text() == "😊", "普通点击情绪应回默认"

    # 加时后进度条按新总时长倒退，不倒顶
    window.remaining = 5
    window.extra_seconds = 0
    window._update_progress()
    before = window.progress_bar.value()
    assert before < 100, "休息中进度条不应满格"
    window._add_bonus_time()
    after = window.progress_bar.value()
    assert after <= 100, "加时后进度条不应顶格"
    assert after > before, "加时后进度条应倒退回升"

    # 停滞时红叉盖住倒计时，恢复后撤掉
    window._stall_countdown()
    app.processEvents()
    assert window.stall_overlay.isVisible(), "停滞时红叉应显示"
    assert not window._countdown_timer.isActive(), "停滞时倒计时应暂停"
    assert "0.35" in window.timer_label.styleSheet(), "停滞时数字应变灰"
    # 停滞期间点击无效：不计数不抽签
    clicks_before = window.skip_clicks
    window._on_skip()
    assert window.skip_clicks == clicks_before, "停滞期间点击不应生效"
    window._stall_ticks = window._stall_total - 1
    window._stall_tick()
    app.processEvents()
    assert not window.stall_overlay.isVisible(), "恢复后红叉应隐藏"
    assert "#2D5A4D" in window.timer_label.styleSheet(), "恢复后数字应回色"

    # 按钮没收：消失后恢复并回到中心
    window._center_skip_button()
    window._evade_active = True
    center_before = window.btn_skip.pos()
    window._confiscate_button()
    app.processEvents()
    assert not window.btn_skip.isVisible(), "没收时按钮应隐藏"
    assert window.confiscates == 1, "没收应计数"
    QTest.qWait(1800)
    assert window.btn_skip.isVisible(), "没收结束按钮应恢复"
    assert window.btn_skip.pos() == center_before, "恢复后应回到初始位置"

    # 按钮不在中心时，停手后应调度回中心（不额外点击，避免打乱统计）
    window._evade_once(QPoint(5, 5))
    QTest.qWait(400)
    assert window.btn_skip.pos() != window._center_pos(), "划走后应离开中心"
    window._cancel_return_center()
    window._schedule_return_center()
    assert window._return_timer is not None, "按钮不在中心应调度回中心"

    # 划走动画运行中：再触发 move 不打断；点击跳过也被忽略（点到的都是空气）
    window._evade_active = True
    window._evade_once(QPoint(5, 5))
    QTest.qWait(60)   # 让动画进入运行状态
    assert window._evade_anim is not None and window._evade_anim.state() == QAbstractAnimation.State.Running, "划走动画应处于运行中"
    assert window._evade_anim.duration() == 150, f"划走动画应快（150ms）：{window._evade_anim.duration()}"
    assert not window._move_skip_button_on_click(), "动画运行中不应打断划走"
    clicks_before = window.skip_clicks
    window._on_skip()   # 动画中点击跳过
    assert window.skip_clicks == clicks_before, "动画运行中点击不应生效"
    QTest.qWait(300)

    # 追击窗口：move 触发后短暂开启，用于追着逃的体验；追加次数用完立即结束
    window._evade_chase_until = 0.0
    window._evade_cooldown_until = 0.0
    window.button_evades = 0
    assert window._move_skip_button_on_click(), "应能触发划走"
    assert window._evade_chase_until > time.time(), "划走后应进入追击窗口"
    # 追击再逃一次（chase），用完即清窗口
    window._evade_cooldown_until = 0.0
    assert window._evade_once(QPoint(5, 5), chase=True), "追击窗口内应能再逃一次"
    assert window.button_evades >= window.max_button_evades, "追加后次数应达到上限"
    assert window._evade_chase_until == 0.0, "追加次数用完应立即结束追击窗口"
    assert "还敢追" in window.feedback.text(), "追击逃跑应提示这是最后一次"

    # 划走后会自动滑回初始位置
    window._center_skip_button()
    center_before = window.btn_skip.pos()
    window._evade_active = True
    window._evade_once(QPoint(5, 5))
    app.processEvents()
    assert window._evade_anim is not None and window._evade_anim.state() == QAbstractAnimation.State.Running, "划走动画应启动"
    assert window.button_evades >= 1, "划走应计数"
    QTest.qWait(400)
    assert window.btn_skip.pos() != center_before, "划走应离开初始位置"
    window._cancel_return_center()
    window._return_center()
    QTest.qWait(450)
    assert window.btn_skip.pos() == center_before, "滑回后应回到初始位置"

    # 加时上限
    window.extra_seconds = MAX_EXTRA_SECONDS - 10
    bonus = window._add_bonus_time()
    assert 0 <= bonus <= 10, f"加时突破上限：{bonus}"
    assert window.extra_seconds <= MAX_EXTRA_SECONDS

    # 长文案换行显示
    window._show_reply("这是一段需要换行的长文案，应该完整显示在休息窗口里，而不是只露出前两行。" * 2)
    app.processEvents()
    assert window.feedback.minimumHeight() > 0, "长文案没有计算出可见高度"
    assert window.msg.minimumHeight() >= max(1, msg_height), "动态回复撑开后遮住了助手提醒文案"

    # 划走次数封顶
    window.button_evades = window.max_button_evades
    assert not window._move_skip_button_on_click(), "次数用满后不应再划走"

    # 三击 emoji 逃生出口：连续三击触发，间隔超时不算
    escaped = {"called": False}
    window._escape = lambda: escaped.__setitem__("called", True)
    QTest.mouseClick(window.emotion_bubble, Qt.MouseButton.LeftButton)
    QTest.mouseClick(window.emotion_bubble, Qt.MouseButton.LeftButton)
    QTest.mouseClick(window.emotion_bubble, Qt.MouseButton.LeftButton)
    assert escaped["called"], "连续三击 emoji 应触发逃生"
    escaped["called"] = False
    window._triple_click_count = 0
    QTest.mouseClick(window.emotion_bubble, Qt.MouseButton.LeftButton)   # count=1
    window._triple_click_last = time.time() - 1.0                        # 假装间隔太久
    QTest.mouseClick(window.emotion_bubble, Qt.MouseButton.LeftButton)   # count 重置为 1
    QTest.mouseClick(window.emotion_bubble, Qt.MouseButton.LeftButton)   # count=2
    assert not escaped["called"], "间隔超时不应触发三击"
    QTest.mouseClick(window.emotion_bubble, Qt.MouseButton.LeftButton)   # count=3
    assert escaped["called"], "补上第三击应触发逃生"

    window._finish_completed()
    app.processEvents()
    names = os.listdir(ipc_dir)
    settle_requests = [name for name in names if name.startswith("request-") and "settle" in name]
    assert len(settle_requests) == 1, f"预期 1 个结算请求，实际 {settle_requests}"
    summaries = [name for name in names if name.startswith("summary-")]
    assert len(summaries) == 1, f"预期 1 个 summary，实际 {summaries}"
    with open(os.path.join(ipc_dir, summaries[0]), "r", encoding="utf-8") as handle:
        summary = json.load(handle)
    assert summary["windowId"] == "w-self-test"
    assert summary["action"] == "completed"
    assert summary["skips"] == 2
    assert summary["confiscates"] == 1
    assert summary["struggle"] is True
    window.close()

print("PYQT_SELF_TEST_OK")
