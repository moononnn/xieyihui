// 歇一会 - 生命周期入口

import { start as startTimer, stop as stopTimer } from "./tools/_lib/timer.js";

export default class XieYiHuiPlugin {
  async onload() {
    startTimer(this.ctx);
  }

  async onunload() {
    stopTimer();
  }
}
