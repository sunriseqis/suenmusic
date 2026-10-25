import SwiftUI
import UIKit

/// 只认「向右横向拖动」的手势桥（替代行内 SwiftUI `DragGesture`）。
///
/// 为什么必须换：SwiftUI 的 `DragGesture` 挂在行上会和外层 `UIScrollView` 抢手势，
/// 实测「手指落在行上就滑不动列表，只有空白处能滚」。UIKit 的 pan 识别器可以
/// ① `gestureRecognizerShouldBegin` 只在明显横向时接管；② 与滚动识别器**并行识别**。
/// 自身视图 `isUserInteractionEnabled = false`，点击/滚动照常透传。
struct HorizontalSwipeInstaller: UIViewRepresentable {
    let onChanged: (CGFloat) -> Void
    let onEnded: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UIView {
        let probe = ProbeView()
        probe.coordinator = context.coordinator
        probe.isUserInteractionEnabled = false
        probe.backgroundColor = .clear
        return probe
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.parent = self
    }

    /// 探针视图：**在 didMoveToWindow 里装手势**。
    ///
    /// 之前放在 makeUIView + DispatchQueue.main.async 里：那一刻视图还没进层级，
    /// `superview` 为 nil → 安装代码被跳过、之后永不重试 → pan 从来没挂上（右滑无效的真因）。
    final class ProbeView: UIView {
        weak var coordinator: Coordinator?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard let coordinator else { return }
            // ⚠️ 不能挂在 `superview` 上：SwiftUI 给 background 包了一层
            //   `UIKitPlatformViewHost<…HorizontalSwipeInstaller>`，它在**行内容之下**；
            //   手指落在行上时触摸归最上层的内容视图，那一层的识别器永远收不到（实测右滑无效）。
            //   所以顺着祖先链往上找「高度≈行高」的那一层（行容器），把 pan 挂在那里。
            guard let host = Self.findRowHost(from: self) else { return }
            if host.gestureRecognizers?.contains(where: { $0 is SwipePan }) == true { return }
            let pan = SwipePan(target: coordinator, action: #selector(Coordinator.handle(_:)))
            pan.delegate = coordinator
            pan.cancelsTouchesInView = false
            host.addGestureRecognizer(pan)
            NSLog("[Swipe] pan 已挂到 \(type(of: host)) h=%.0f", host.bounds.height)
        }

        /// 找「行」的宿主视图。
        ///
        /// 关键区别：**在 `List` 里每行是真实的 cell 视图**（UICollectionViewCell / UITableViewCell），
        /// 而在 `ScrollView + LazyVStack` 里行会被 SwiftUI 扁平化 —— 这就是之前 pan 只能挂到
        /// background 包装层、收不到触摸的原因。所以这里优先认 cell；找不到再退回父视图。
        private static func findRowHost(from view: UIView) -> UIView? {
            var node: UIView? = view.superview
            var hops = 0
            while let current = node, hops < 10 {
                if current is UICollectionViewCell || current is UITableViewCell { return current }
                // SwiftUI 的 List 在较新系统上用的是私有 cell 类，兜底按类名判断
                let name = String(describing: type(of: current))
                if name.contains("Cell") || name.contains("ListRow") { return current }
                node = current.superview
                hops += 1
            }
            return view.superview
        }
    }

    final class SwipePan: UIPanGestureRecognizer {}

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: HorizontalSwipeInstaller
        init(_ parent: HorizontalSwipeInstaller) { self.parent = parent }

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            guard g is SwipePan, let view = g.view as? UIView else { return false }
            // ⚠️ 必须用 velocity，不能用 translation：在「将要开始」这一刻 translation 恒为 (0,0)，
            //    拿它判断会永远 return false —— 这就是上一版「右滑无效」的原因。
            //    velocity 在此刻已有方向，可用它区分横向/纵向。
            let v = (g as! SwipePan).velocity(in: view)
            let ok = v.x > 0 && abs(v.x) > abs(v.y)
            NSLog("[Swipe] shouldBegin vx=%.0f vy=%.0f → %@", v.x, v.y, ok ? "接管" : "放行")
            return ok
        }

        func gestureRecognizer(_ g: UIGestureRecognizer,
                              shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }

        @objc func handle(_ pan: SwipePan) {
            guard let view = pan.view else { return }
            switch pan.state {
            case .changed:
                let dx = pan.translation(in: view).x
                NSLog("[Swipe] changed dx=%.0f", dx)
                parent.onChanged(dx)
            case .ended, .cancelled, .failed:
                parent.onEnded()
            default:
                break
            }
        }
    }
}