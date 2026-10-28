import { AbilityConstant, Configuration, ConfigurationConstant, EnvironmentCallback, UIAbility, Want } from '@kit.AbilityKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { window } from '@kit.ArkUI';
import { rpc } from '@kit.IPCKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { formBindingData, formProvider, formInfo } from '@kit.FormKit';
import { dispatchCardControl, CardControlRequest } from '../common/PlayerControlHub';
import { Notifier } from '../common/Notifier';
import { KugouVerify } from '../core/KugouVerify';
import { Theme, ThemeMode } from '../common/Theme';
import {
  NowPlayingSnapshot,
  readSnapshotSync,
  writeSnapshotSync,
  buildFormBindingObject,
  openCoverFd,
  closeCoverFd
} from '../common/NowPlaying';

const TAG = 'SuenMusic_EntryAbility';
const DOMAIN = 0x0000;

/**
 * callee 回调必须返回至少一个空的 Parcelable（SDK 注释原话：Otherwise,
 * the function execution fails）—— postCardAction 的 call 事件同样受这条
 * 约束。这里回一个最小实现，内容不携带信息。
 */
class CardControlResult implements rpc.Parcelable {
  marshalling(sequence: rpc.MessageSequence): boolean {
    try {
      sequence.writeInt(0);
    } catch (e) {
      hilog.error(DOMAIN, TAG, 'CardControlResult.marshalling 失败: %{public}s', JSON.stringify(e));
    }
    return true;
  }

  unmarshalling(sequence: rpc.MessageSequence): boolean {
    return true;
  }
}

/**
 * 应用级环境变化回调。
 *
 * ⚠️ 为什么不用 `Ability.onConfigurationUpdate`：那个回调在应用**后台时经常收不到**，
 * 于是「切系统深浅 → 只有把 app 唤回前台卡片才变色」（用户 2026-10-24 实测）。
 * `ApplicationContext.on('environment')` 是应用级订阅，退到后台也会回调。
 */
class SuenEnvCallback extends EnvironmentCallback {
  private sink: (cfg: Configuration) => void;

  constructor(sink: (cfg: Configuration) => void) {
    super();
    this.sink = sink;
  }

  onConfigurationUpdated(config: Configuration): void {
    this.sink(config);
  }

  onMemoryLevel(level: AbilityConstant.MemoryLevel): void {
    // 不关心内存回调
  }
}

export default class EntryAbility extends UIAbility {
  /**
   * 系统环境（含深浅色）变化 → 同步系统态；「跟随系统」模式下**立刻重推卡片**。
   * 只在深浅真的变化时推，避免重复刷卡片。
   */
  private applySystemColorMode(colorMode: ConfigurationConstant.ColorMode | undefined): void {
    const cm = colorMode === undefined ? ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET : colorMode;
    // 只同步系统态缓存。
    // 之前在「跟随系统」时这里还会重推一次卡片，但用户实测（349e6a7）卡片仍然不实时 ——
    // 推送并不能让卡片渲染侧重绘，白付一次表单刷新，故删除（省资源；卡片实时性已列为已知限制）。
    Theme.syncSystemDark(cm);
  }

  /** 应用级环境订阅：后台也能收到系统深浅变化 */
  private registerEnvironmentListener(): void {
    try {
      const appCtx = this.context.getApplicationContext();
      appCtx.on('environment', new SuenEnvCallback((cfg: Configuration): void => {
        this.applySystemColorMode(cfg.colorMode);
      }));
      hilog.info(DOMAIN, TAG, '系统环境监听注册成功');
    } catch (err) {
      hilog.error(DOMAIN, TAG, '系统环境监听注册失败：%{public}s', JSON.stringify(err));
    }
  }

  /**
   * 系统深浅变化。
   *
   * ⚠️ 除了记下系统态，**还要在「跟随系统」模式下立刻重推卡片**：
   * 卡片颜色是 payload 里的 suen_dark 驱动的（不受 setColorMode 影响），
   * 不主动推的话，切系统主题后卡片要等到下一次播放状态变化或系统定时刷新才变 ——
   * 用户 2026-10-24 实测：「切系统浅色，app 正常但卡片无变化，起播后才变，过一会才变深」。
   */
  onConfigurationUpdate(newConfig: Configuration): void {
    this.applySystemColorMode(newConfig.colorMode);
  }

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onCreate');
    // 主题：先把上次选择的深浅应用上（必须在窗口内容加载前，避免闪一次系统主题）
    Theme.init(this.context);
    // 系统通知落地口需要 UIAbilityContext（首次发布时才真正请求授权）
    Notifier.init(this.context);
    this.registerEnvironmentListener();
    this.registerCardCallee();
    // router 事件（或未来的其他前台拉起）可以带 control 参数进来
    this.dispatchControlFromWant(want);
    // 「酷狗需要验证」通知的点击：冷启动走这里
    this.openVerifyFromWant(want);
  }

  /**
   * 「酷狗需要验证」通知的点击落点（冷启动 onNewWant/onCreate 都可能走到）。
   *
   * WantAgent 把本 Ability 拉到前台，待打开的验证页地址放在 want.uri；
   * 这里转手交给系统浏览器。只认 http(s)：别让任意 uri 借这条通道拉起应用。
   */
  private openVerifyFromWant(want: Want): void {
    try {
      const uri = want.uri;
      if (typeof uri !== 'string' || uri.length === 0) {
        return;
      }
      if (!uri.startsWith('http://') && !uri.startsWith('https://')) {
        return;
      }
      hilog.info(DOMAIN, TAG, '通知点击要求在浏览器打开验证页');
      KugouVerify.openInBrowser(this.context, uri);
    } catch (err) {
      hilog.error(DOMAIN, TAG, '解析通知 uri 失败：%{public}s', JSON.stringify(err));
    }
  }

  /**
   * 桌面卡片按钮的后台落点：postCardAction 的 call 事件（method='control'）。
   *
   * 卡片按 suen_alive 分流：应用活着走 call（后台直达、不惊动前台），
   * 死了走 router（冷启动完整拉起）。
   *
   * T6 后为纯原生分发：指令直达 MediaPlayerCore（空队列时是安全 no-op），
   * 不再有"网页是否就绪"的判断（WebView 壳已删，见 S5 §三）。
   */
  private registerCardCallee(): void {
    try {
      this.callee.on('control', (data: rpc.MessageSequence) => {
        try {
          const raw = data.readString();
          hilog.info(DOMAIN, TAG, '收到卡片 call 事件：%{public}s', raw);
          const req = JSON.parse(raw) as CardControlRequest;
          if (req.control && req.control.length > 0) {
            dispatchCardControl(req.control);
          }
        } catch (err) {
          hilog.error(DOMAIN, TAG, '卡片指令解析失败：%{public}s', JSON.stringify(err));
        }
        return new CardControlResult();
      });
      hilog.info(DOMAIN, TAG, '卡片 callee(control) 注册成功');
    } catch (err) {
      hilog.error(DOMAIN, TAG, '卡片 callee 注册失败：%{public}s',
        JSON.stringify(err as BusinessError));
    }
  }

  /**
   * 把快照推给所有运行中的卡片（带封面 fd，避免 formImages 缺失丢封面）。
   * fd 在每张卡的 updateForm await 之后由 closeCoverFd 关闭是安全时序；
   * 这里为简化在整批复送完后统一关（IPC 序列化时 fd 已被系统复制）。
   */
  private pushSnapshotToCards(snap: NowPlayingSnapshot, sysDarkOverride?: boolean): void {
    // 与 Index.syncCard / SuenFormAbility 一致：只有快照声明封面就绪才开 fd，
    // 否则 payload 说无封面却塞旧 formImages，既浪费也存在新旧不一致的边角。
    const coverFd = snap.coverReady ? openCoverFd(this.context) : -1;
    formProvider.getPublishedRunningFormInfos()
      .then(async (infos: Array<formInfo.RunningFormInfo>) => {
        for (const info of infos) {
          const dimension = info.dimension === formInfo.FormDimension.Dimension_2_4 ? '3' : '2';
          // 系统深浅优先用调用方传进来的（onConfigurationUpdate 时 context.config 可能还没刷新）
          const sysDark = sysDarkOverride === undefined
            ? Theme.isSystemDark(this.context.config.colorMode)
            : sysDarkOverride;
          const obj = buildFormBindingObject(snap, dimension, coverFd, Theme.darkFor(this.context, sysDark));
          try {
            await formProvider.updateForm(info.formId, formBindingData.createFormBindingData(obj));
          } catch (err) {
            hilog.error(DOMAIN, TAG, '刷卡片失败 formId=%{public}s：%{public}s',
              info.formId, JSON.stringify(err));
          }
        }
        closeCoverFd(coverFd);
      })
      .catch((err: BusinessError) => {
        closeCoverFd(coverFd);
        hilog.error(DOMAIN, TAG, '读取卡片列表失败：%{public}s', JSON.stringify(err));
      });
  }

  /** 从 want.parameters 里取 control 指令（router 前台拉起的参数通道） */
  private dispatchControlFromWant(want: Want): void {
    try {
      const params = want.parameters;
      if (!params) {
        return;
      }
      const control = params['control'];
      if (typeof control === 'string' && control.length > 0) {
        hilog.info(DOMAIN, TAG, 'want 参数携带控制指令：%{public}s', control);
        dispatchCardControl(control);
      }
    } catch (err) {
      hilog.error(DOMAIN, TAG, '解析 want 控制参数失败：%{public}s', JSON.stringify(err));
    }
  }

  onDestroy(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onDestroy');
    // 进程收尾：快照里的 playing / alive 状态已经不真实了（播放器已死）。
    // 不重置的话卡片会一直显示"播放中"的陈旧按钮态、按钮继续走 call 死路，
    // 直到下一次切歌/进应用。
    this.resetSnapshotOnDestroy();
  }

  /**
   * onDestroy 里的收尾：快照 playing=false + alive=false 落盘 + 主动刷一遍
   * 卡片。全部走同步 API（writeSnapshotSync）—— onDestroy 之后进程随时可能
   * 被收走，异步路径等于没写。
   */
  private resetSnapshotOnDestroy(): void {
    try {
      const snap: NowPlayingSnapshot = readSnapshotSync(this.context);
      if (!snap.playing && !snap.alive) {
        return;
      }
      snap.playing = false;
      snap.alive = false;
      snap.updatedAt = new Date().getTime();
      writeSnapshotSync(this.context, snap);
      this.pushSnapshotToCards(snap);
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'onDestroy 重置快照失败：%{public}s', JSON.stringify(err));
    }
  }

  onWindowStageCreate(windowStage: window.WindowStage): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onWindowStageCreate');

    try {
      const mainWindow = windowStage.getMainWindowSync();

      // 设置沉浸式全屏布局
      mainWindow.setWindowLayoutFullScreen(true);

      // 获取顶部状态栏避让区与底部导航栏避让区高度 (px)
      const topAvoidArea = mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM);
      const bottomAvoidArea = mainWindow.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR);

      AppStorage.setOrCreate('topAvoidHeight', topAvoidArea.topRect.height);
      AppStorage.setOrCreate('bottomAvoidHeight', bottomAvoidArea.bottomRect.height);

      // 监听窗口避让区域变化（如软键盘弹出或横竖屏旋转）
      mainWindow.on('avoidAreaChange', (data) => {
        if (data.type === window.AvoidAreaType.TYPE_SYSTEM) {
          AppStorage.setOrCreate('topAvoidHeight', data.area.topRect.height);
        } else if (data.type === window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR) {
          AppStorage.setOrCreate('bottomAvoidHeight', data.area.bottomRect.height);
        }
      });

      // 设置系统状态栏图标颜色风格
      mainWindow.setWindowSystemBarProperties({
        statusBarContentColor: '#1E293B',
        navigationBarContentColor: '#1E293B'
      });
    } catch (err) {
      hilog.error(DOMAIN, TAG, 'Failed to configure window: %{public}s', JSON.stringify(err));
    }

    // ⚠️ 入口页在这里**硬编码**，必须与 `resources/base/profile/main_pages.json` 保持一致。
    // 改 main_pages 却忘了这里 → err.code = 401（加载了未注册的页面路径），
    // 现象是白屏 + 日志只有一行 "Failed to load content"。
    windowStage.loadContent('pages/NativeRoot', (err) => {
      if (err.code) {
        hilog.error(DOMAIN, TAG, 'Failed to load content: %{public}s', JSON.stringify(err));
        return;
      }
      hilog.info(DOMAIN, TAG, 'Succeeded in loading content.');
    });
  }

  onWindowStageDestroy(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onWindowStageDestroy');
  }

  onForeground(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onForeground');
  }

  onBackground(): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onBackground');
  }

  onNewWant(want: Want, launchParam: AbilityConstant.LaunchParam): void {
    hilog.info(DOMAIN, TAG, '%{public}s', 'Ability onNewWant');
    this.dispatchControlFromWant(want);
    // 热启动时 App 已在后台，通知点击走这里
    this.openVerifyFromWant(want);
  }
}
