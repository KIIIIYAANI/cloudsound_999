// cloudsound_999 — native macOS shell.
// Owns a window with a WKWebView, starts/stops the bundled local server (FastAPI + yt-dlp),
// and bridges a few native niceties: folder picker, Dock badge, menus, quit confirmation.
import Cocoa
import WebKit

let kPort = 9990
let kBase = "http://127.0.0.1:\(kPort)"
let kSkins: [(id: String, name: String)] = [
    ("matrix", "Matrix"), ("lymewire", "LymeWire"), ("napsterr", "Napsterr"),
    ("hotfries", "HotFries"), ("joekool", "JoeKool"), ("postal", "POSTAL"), ("noir", "Noir"),
]

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSMenuDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var logHandle: FileHandle?
    var activeDownloads = 0
    var currentSkin = "matrix"
    var skinMenu = NSMenu(title: "Skin")
    var bootStarted = Date()
    var appLoaded = false          // the console page (not the splash) is showing
    var pendingLinks: [String] = []  // links dropped before the console was ready

    let codeDir = Bundle.main.resourceURL!.appendingPathComponent("cloudsound_999")
    let dataDir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("cloudsound_999")
    }()
    var logURL: URL { dataDir.appendingPathComponent("server.log") }

    // MARK: lifecycle
    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.servicesProvider = self   // "Add to cloudsound_999 Queue" service; also handles text dropped on the Dock icon
        NSUpdateDynamicServices()
        buildMenus()
        buildWindow()
        boot()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard activeDownloads > 0 else { return .terminateNow }
        let a = NSAlert()
        a.messageText = "Quit cloudsound_999?"
        a.informativeText = "\(activeDownloads) download\(activeDownloads == 1 ? " is" : "s are") in progress. They'll be paused and can be resumed next time."
        a.addButton(withTitle: "Quit")
        a.addButton(withTitle: "Cancel")
        return a.runModal() == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
    }

    func applicationWillTerminate(_ note: Notification) { stopServer() }

    // MARK: window
    func buildWindow() {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(self, name: "cs999")
        cfg.websiteDataStore = .default()
        cfg.mediaTypesRequiringUserActionForPlayback = []   // the player auto-advances to the next track
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        if #available(macOS 13.3, *) { web.isInspectable = true }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 800),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "cloudsound_999"
        window.titlebarAppearsTransparent = false
        window.minSize = NSSize(width: 860, height: 640)
        window.tabbingMode = .disallowed
        window.backgroundColor = NSColor(calibratedRed: 0.008, green: 0.024, blue: 0.016, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("cloudsound_999.main")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: server
    func boot() {
        bootStarted = Date()
        showPage(splash(title: "Starting…", detail: firstRun ? "First launch: setting things up. This takes about a minute." : ""))
        checkHealth { up in
            if up { self.loadApp(); return }
            self.startServer()
            self.waitForServer()
        }
    }

    var firstRun: Bool {
        !FileManager.default.isExecutableFile(atPath: dataDir.appendingPathComponent(".venv/bin/python").path)
    }

    func startServer() {
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        logHandle = try? FileHandle(forWritingTo: logURL)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = [codeDir.appendingPathComponent("run.sh").path]
        p.currentDirectoryURL = codeDir
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        env["CS999_DATA_DIR"] = dataDir.path
        env["CS999_VENV"] = dataDir.appendingPathComponent(".venv").path
        env["NO_BROWSER"] = "1"
        env["PORT"] = String(kPort)
        p.environment = env
        p.standardOutput = logHandle
        p.standardError = logHandle
        p.standardInput = FileHandle.nullDevice
        do { try p.run(); server = p } catch { fail("Couldn't start the background service: \(error.localizedDescription)") }
    }

    func waitForServer() {
        checkHealth { up in
            if up { self.loadApp(); return }
            if let s = self.server, !s.isRunning { self.fail(nil); return }
            if Date().timeIntervalSince(self.bootStarted) > 180 { self.fail("Timed out waiting for the background service."); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.waitForServer() }
        }
    }

    func checkHealth(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: URL(string: kBase + "/api/health")!)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func stopServer() {
        guard let p = server, p.isRunning else { return }
        p.terminate() // SIGTERM -> uvicorn graceful shutdown (pauses downloads, saves the queue)
        let deadline = Date().addingTimeInterval(5)
        while p.isRunning && Date() < deadline { usleep(100_000) }
        if p.isRunning { kill(p.processIdentifier, SIGKILL) }
    }

    func loadApp() { web.load(URLRequest(url: URL(string: kBase + "/")!)) }

    func fail(_ reason: String?) {
        var tail = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
        tail = tail.split(separator: "\n").suffix(8).joined(separator: "\n")
        showPage(splash(title: "cloudsound_999 couldn't start",
                        detail: (reason ?? "The background service stopped unexpectedly.") +
                        "<br><br>It needs Python 3, plus yt-dlp and ffmpeg for downloads. With <a href=\"https://brew.sh\">Homebrew</a> installed, run this in Terminal:<pre>brew install python yt-dlp ffmpeg</pre>",
                        log: tail, retry: true))
    }

    // MARK: pages
    func showPage(_ html: String) { web.loadHTMLString(html, baseURL: nil) }

    func splash(title: String, detail: String, log: String = "", retry: Bool = false) -> String {
        let esc = log.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        return """
        <!doctype html><meta charset="utf-8"><style>
        :root{color-scheme:dark}
        html,body{height:100%;margin:0;background:radial-gradient(ellipse at 50% 35%,#04140b,#020604 60%,#000);color:#c8ffd9;font:14px/1.5 ui-monospace,Menlo,monospace}
        .c{height:100%;display:grid;place-content:center;text-align:center;padding:24px}
        .eye{width:64px;height:64px;margin:0 auto 26px;border:2px solid #19ff8c;border-radius:50%;display:grid;place-items:center;box-shadow:0 0 18px rgba(25,255,140,.45)}
        .eye i{width:16px;height:16px;border-radius:50%;background:#ff2bd6;box-shadow:0 0 14px #ff2bd6;animation:p 1.6s ease-in-out infinite}
        @keyframes p{50%{opacity:.35;transform:scale(.8)}}
        h1{font-weight:500;font-size:15px;letter-spacing:.3em;text-transform:uppercase;margin:0 0 10px}
        h1{color:#00f0ff}
        p{color:#4cc07c;max-width:520px;margin:0 auto}
        pre{background:#000;border:1px solid #19ff8c;padding:10px 14px;text-align:left;white-space:pre-wrap;font:12px ui-monospace,Menlo,monospace;color:#c8ffd9}
        .log{max-width:640px;margin:18px auto 0;color:#4cc07c;border-color:rgba(25,255,140,.3)}
        button{margin-top:22px;font:inherit;letter-spacing:.12em;text-transform:uppercase;font-size:12px;padding:8px 18px;background:linear-gradient(90deg,#00f0ff,#ff2bd6);color:#000;border:0;cursor:pointer}
        a{color:inherit}
        </style><div class="c"><div class="eye"><i></i></div><h1>\(title)</h1><p>\(detail)</p>
        \(log.isEmpty ? "" : "<pre class=\"log\">\(esc)</pre>")
        \(retry ? "<div><button onclick=\"webkit.messageHandlers.cs999.postMessage({type:'retry'})\">Try again</button></div>" : "")
        </div>
        """
    }

    // MARK: navigation
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, url.scheme?.hasPrefix("http") == true, url.host != "127.0.0.1",
           action.targetFrame?.isMainFrame != false {
            if action.navigationType == .linkActivated {
                NSWorkspace.shared.open(url) // external links open in the user's browser
            } else {
                enqueue([url.absoluteString]) // a link dropped onto the window: queue it, don't navigate away
            }
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        appLoaded = webView.url?.absoluteString.hasPrefix(kBase) == true
        flushLinks()
        webView.evaluateJavaScript("document.documentElement.dataset.skin || ''") { v, _ in
            if let s = v as? String, !s.isEmpty { self.currentSkin = s; self.refreshSkinChecks() }
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }

    // MARK: links dropped on the Dock icon / window, or sent via Services
    func application(_ application: NSApplication, open urls: [URL]) {
        var links: [String] = []
        for u in urls {
            if u.isFileURL { links += linksInFile(u) } else { links.append(u.absoluteString) }
        }
        enqueue(links)
    }
    func linksInFile(_ u: URL) -> [String] {
        if u.pathExtension.lowercased() == "webloc",
           let d = try? Data(contentsOf: u),
           let pl = try? PropertyListSerialization.propertyList(from: d, format: nil) as? [String: Any],
           let s = pl["URL"] as? String { return [s] }
        guard let text = try? String(contentsOf: u, encoding: .utf8) else { return [] }
        return extractLinks(text)
    }
    func extractLinks(_ text: String) -> [String] {
        guard let re = try? NSRegularExpression(pattern: "https?://[^\\s<>\"']+") else { return [] }
        let ns = text as NSString
        return re.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range) }
    }
    @objc func addLinks(_ pboard: NSPasteboard, userData: String?, error: AutoreleasingUnsafeMutablePointer<NSString>) {
        var links: [String] = []
        if let urls = pboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL] {
            links += urls.filter { !$0.isFileURL }.map { $0.absoluteString }
        }
        if let s = pboard.string(forType: .string) { links += extractLinks(s) }
        enqueue(links)
    }
    func enqueue(_ links: [String]) {
        var seen = Set<String>()
        let clean = links.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.lowercased().hasPrefix("http") && seen.insert($0).inserted }
        DispatchQueue.main.async {
            if clean.isEmpty { NSSound.beep(); return }
            self.pendingLinks += clean
            NSApp.activate(ignoringOtherApps: true)
            self.window?.makeKeyAndOrderFront(nil)
            self.flushLinks()
        }
    }
    func flushLinks() {
        guard appLoaded, web != nil, !pendingLinks.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: pendingLinks),
              let json = String(data: data, encoding: .utf8) else { return }
        pendingLinks.removeAll()
        web.evaluateJavaScript("window.__cs999AddUrls && window.__cs999AddUrls(\(json))", completionHandler: nil)
    }

    // MARK: JS bridge
    func userContentController(_ uc: WKUserContentController, didReceive msg: WKScriptMessage) {
        guard let body = msg.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "retry":
            boot()
        case "chooseFolder":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.canCreateDirectories = true
            panel.prompt = "Save Here"
            panel.message = "Choose where cloudsound_999 saves audio"
            if let cur = body["current"] as? String, !cur.isEmpty { panel.directoryURL = URL(fileURLWithPath: cur) }
            panel.beginSheetModal(for: window) { resp in
                let path = resp == .OK ? panel.url?.path : nil
                let arg = path.flatMap { try? String(data: JSONSerialization.data(withJSONObject: [$0]), encoding: .utf8) }
                    .map { String($0.dropFirst().dropLast()) } ?? "null"
                self.web.evaluateJavaScript("window.__cs999Folder && window.__cs999Folder(\(arg))")
            }
        case "status":
            activeDownloads = body["active"] as? Int ?? 0
            NSApp.dockTile.badgeLabel = activeDownloads > 0 ? String(activeDownloads) : nil
        case "skin":
            if let s = body["skin"] as? String { currentSkin = s; refreshSkinChecks() }
        default: break
        }
    }

    // MARK: menus
    func buildMenus() {
        let main = NSMenu()

        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "About cloudsound_999", action: #selector(about), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide cloudsound_999", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let ho = app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        ho.keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit cloudsound_999", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app

        let fileItem = NSMenuItem(); main.addItem(fileItem)
        let file = NSMenu(title: "File")
        file.addItem(withTitle: "Add URLs…", action: #selector(focusAdd), keyEquivalent: "l")
        file.addItem(withTitle: "Choose Download Folder…", action: #selector(chooseFolder), keyEquivalent: "o")
        let of = file.addItem(withTitle: "Open Download Folder", action: #selector(openFolder), keyEquivalent: "o")
        of.keyEquivalentModifierMask = [.command, .shift]
        file.addItem(.separator())
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = file

        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        let skinItem = NSMenuItem(title: "Skin", action: nil, keyEquivalent: "")
        for (i, s) in kSkins.enumerated() {
            let it = skinMenu.addItem(withTitle: s.name, action: #selector(pickSkin(_:)), keyEquivalent: String(i + 1))
            it.representedObject = s.id
        }
        skinItem.submenu = skinMenu
        view.addItem(skinItem)
        view.addItem(.separator())
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        let fs = view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fs.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        winItem.submenu = win
        NSApp.windowsMenu = win

        let helpItem = NSMenuItem(); main.addItem(helpItem)
        let help = NSMenu(title: "Help")
        help.addItem(withTitle: "Show Server Log", action: #selector(showLog), keyEquivalent: "")
        help.addItem(withTitle: "yt-dlp Supported Sites", action: #selector(openYtdlp), keyEquivalent: "")
        helpItem.submenu = help
        NSApp.helpMenu = help

        NSApp.mainMenu = main
        refreshSkinChecks()
    }

    func refreshSkinChecks() {
        for it in skinMenu.items { it.state = (it.representedObject as? String) == currentSkin ? .on : .off }
    }

    func js(_ code: String) { web.evaluateJavaScript(code, completionHandler: nil) }

    @objc func pickSkin(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        currentSkin = id; refreshSkinChecks()
        js("typeof applySkin==='function' && applySkin(\(String(reflecting: id)))")
    }
    @objc func openSettings() { js("typeof openSettings==='function' && openSettings()") }
    @objc func focusAdd() { js("var u=document.getElementById('urlInput'); u && (u.focus(), u.select())") }
    @objc func chooseFolder() { js("typeof cmd==='function' && cmd('folder')") }
    @objc func openFolder() { js("typeof cmd==='function' && cmd('reveal', [])") }
    @objc func reload() { if web.url?.host == "127.0.0.1" { web.reload() } else { boot() } }
    @objc func showLog() { NSWorkspace.shared.activateFileViewerSelecting([logURL]) }
    @objc func openYtdlp() { NSWorkspace.shared.open(URL(string: "https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md")!) }
    @objc func about() {
        let credits = NSAttributedString(string: "A local SoundCloud audio console powered by yt-dlp.\nOnly download audio you have the rights to.",
                                         attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor])
        NSApp.orderFrontStandardAboutPanel(options: [.credits: credits])
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
