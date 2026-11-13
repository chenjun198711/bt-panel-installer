// 宝塔面板一键安装器 · 桌面版窗口外壳
// 编译：csc -target:winexe -platform:x64 -r:System.dll -r:System.Drawing.dll -r:System.Windows.Forms.dll
//       -r:Microsoft.Web.WebView2.Core.dll -r:Microsoft.Web.WebView2.WinForms.dll
//       -out:BtPanel-Installer.exe desktop\Program.cs
//
// 目录要求（与 exe 同级）：app\server.js、runtime\node.exe
// 运行时自动生成：data\（WebView2 缓存、server.log、links.log）
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class Program
{
    const int Port = 3940;
    const string AppTitle = "宝塔面板一键安装器";
    const string AppWindowTitle = "宝塔面板一键安装器 · 桌面版";

    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern IntPtr FindWindowW(string cls, string title);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr h, int cmd);

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr h);

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        bool createdNew;
        using (Mutex mutex = new Mutex(true, "BtPanelInstallerDesktopShell", out createdNew))
        {
            if (!createdNew)
            {
                IntPtr h = FindWindowW(null, AppWindowTitle);
                if (h != IntPtr.Zero)
                {
                    ShowWindow(h, 9);
                    SetForegroundWindow(h);
                }
                else
                {
                    MessageBox.Show("宝塔面板安装器已经在运行了。\n请在任务栏或桌面查看已打开的窗口。", AppTitle,
                        MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                return;
            }

            string baseDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            string webViewVersion = WebView2Probe.GetVersion();
            if (webViewVersion == null)
            {
                MessageBox.Show(
                    "本程序依赖系统自带的 WebView2 组件，当前系统未检测到该组件。\n\n" +
                    "请先安装 Microsoft Edge WebView2 Runtime（微软官方免费，约 2MB）：\n" +
                    "https://go.microsoft.com/fwlink/p/?LinkId=2124703\n\n" +
                    "装好后再双击运行本程序即可。",
                    AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            Application.Run(new MainForm(baseDir, webViewVersion));
        }
    }
}

static class WebView2Probe
{
    public static string GetVersion()
    {
        try
        {
            string v = CoreWebView2Environment.GetAvailableBrowserVersionString();
            return string.IsNullOrEmpty(v) ? null : v;
        }
        catch
        {
            return null;
        }
    }
}

class MainForm : Form
{
    const int Port = 3940;
    static readonly string Url = "http://127.0.0.1:" + Port + "/";

    readonly string _baseDir;
    readonly string _dataDir;
    readonly string _nodeExe;
    readonly string _appDir;
    readonly string _appEntry;
    readonly string _webViewVersion;

    WebView2 _web;
    Label _status;
    Process _node;
    bool _ownServer;

    public MainForm(string baseDir, string webViewVersion)
    {
        _baseDir = baseDir;
        _webViewVersion = webViewVersion;
        _nodeExe = Path.Combine(baseDir, Path.Combine("runtime", "node.exe"));
        _appDir = Path.Combine(baseDir, "app");
        _appEntry = Path.Combine(_appDir, "server.js");
        _dataDir = ResolveDataDir(baseDir);

        Text = "宝塔面板一键安装器 · 桌面版";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1180, 820);
        MinimumSize = new Size(900, 640);
        BackColor = Color.White;
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
    }

    static string ResolveDataDir(string baseDir)
    {
        try
        {
            string d = Path.Combine(baseDir, "data");
            Directory.CreateDirectory(d);
            string probe = Path.Combine(d, ".writable");
            File.WriteAllText(probe, "1");
            File.Delete(probe);
            return d;
        }
        catch
        {
            string d = Path.Combine(Path.GetTempPath(), "BtPanel-Installer-Data");
            Directory.CreateDirectory(d);
            return d;
        }
    }

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);

        _status = new Label();
        _status.Dock = DockStyle.Fill;
        _status.TextAlign = ContentAlignment.MiddleCenter;
        _status.Font = new Font("Microsoft YaHei UI", 10.5f);
        _status.ForeColor = Color.FromArgb(90, 90, 110);
        _status.Text = "正在启动本地服务，请稍候…";
        Controls.Add(_status);

        if (!File.Exists(_nodeExe) || !File.Exists(_appEntry))
        {
            _status.Text = "程序文件不完整：缺少 runtime\\node.exe 或 app\\server.js。\n请重新解压完整的压缩包。";
            _status.ForeColor = Color.Firebrick;
            return;
        }

        Shown += async delegate { await StartAsync(); };
    }

    async Task StartAsync()
    {
        if (PortServesApp())
        {
            _ownServer = false;
            await ShowUiAsync();
            return;
        }

        if (PortInUse())
        {
            _status.Text = "端口 " + Port + " 已被其它程序占用，无法启动本地服务。\n请关闭占用该端口的程序后重新打开本程序。";
            _status.ForeColor = Color.Firebrick;
            return;
        }

        if (!StartNode())
        {
            _status.Text = "本地服务启动失败，详情见 data\\server.log。";
            _status.ForeColor = Color.Firebrick;
            return;
        }

        _ownServer = true;
        bool up = await Task.Run(delegate { return WaitForPort(30000); });
        if (!up)
        {
            _status.Text = "本地服务未能在 30 秒内就绪，详情见 data\\server.log。";
            _status.ForeColor = Color.Firebrick;
            return;
        }

        await ShowUiAsync();
    }

    async Task ShowUiAsync()
    {
        _web = new WebView2();
        _web.Dock = DockStyle.Fill;
        Controls.Add(_web);
        _web.BringToFront();

        try
        {
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(_dataDir, "webview2"));
            await _web.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex)
        {
            Controls.Remove(_web);
            _web.Dispose();
            _web = null;
            _status.Text = "窗口内核初始化失败：" + ex.Message;
            _status.ForeColor = Color.Firebrick;
            return;
        }

        _web.CoreWebView2.Settings.AreDevToolsEnabled = false;
        _web.CoreWebView2.Settings.IsStatusBarEnabled = false;
        _web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        _web.CoreWebView2.Settings.IsZoomControlEnabled = true;

        // 页面里的外链（VPS 商、官方文档等）都是 target="_blank"：
        // 不接管的话 WebView2 会把新窗口请求吞掉，点了没反应，这里统一交给系统默认浏览器
        _web.CoreWebView2.NewWindowRequested += delegate (object s, CoreWebView2NewWindowRequestedEventArgs ev)
        {
            ev.Handled = true;
            OpenExternal(ev.Uri);
        };

        _web.CoreWebView2.NavigationCompleted += delegate (object s, CoreWebView2NavigationCompletedEventArgs ev)
        {
            if (!ev.IsSuccess) _status.Text = "界面加载失败，错误码：" + ev.WebErrorStatus;
        };

        _web.Source = new Uri(Url);
        Controls.Remove(_status);
    }

    void OpenExternal(string url)
    {
        try
        {
            File.AppendAllText(Path.Combine(_dataDir, "links.log"),
                DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + url + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch { }
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(url);
            psi.UseShellExecute = true;
            Process.Start(psi);
        }
        catch (Exception ex)
        {
            try
            {
                File.AppendAllText(Path.Combine(_dataDir, "links.log"),
                    "open failed: " + ex.Message + Environment.NewLine, new UTF8Encoding(false));
            }
            catch { }
        }
    }

    bool StartNode()
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = _nodeExe;
            psi.Arguments = "\"" + _appEntry + "\"";
            psi.WorkingDirectory = _appDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            psi.EnvironmentVariables["PORT"] = Port.ToString();

            string logPath = Path.Combine(_dataDir, "server.log");
            StreamWriter log = new StreamWriter(logPath, false, new UTF8Encoding(false));
            log.AutoFlush = true;
            object gate = new object();

            _node = new Process();
            _node.StartInfo = psi;
            _node.OutputDataReceived += delegate (object s, DataReceivedEventArgs ev)
            {
                if (ev.Data == null) return;
                lock (gate) { try { log.WriteLine(ev.Data); } catch { } }
            };
            _node.ErrorDataReceived += delegate (object s, DataReceivedEventArgs ev)
            {
                if (ev.Data == null) return;
                lock (gate) { try { log.WriteLine(ev.Data); } catch { } }
            };
            _node.Start();
            _node.BeginOutputReadLine();
            _node.BeginErrorReadLine();
            return true;
        }
        catch (Exception ex)
        {
            try
            {
                File.AppendAllText(Path.Combine(_dataDir, "server.log"),
                    "start failed: " + ex.Message + Environment.NewLine, Encoding.UTF8);
            }
            catch { }
            return false;
        }
    }

    static bool PortInUse()
    {
        try
        {
            using (TcpClient c = new TcpClient())
            {
                IAsyncResult ar = c.BeginConnect("127.0.0.1", Port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(600)) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }

    static bool PortServesApp()
    {
        if (!PortInUse()) return false;
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(Url);
            req.Timeout = 2500;
            req.ReadWriteTimeout = 2500;
            req.Proxy = null;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (Stream s = resp.GetResponseStream())
            using (StreamReader r = new StreamReader(s, Encoding.UTF8))
            {
                char[] buf = new char[4096];
                int n = r.Read(buf, 0, buf.Length);
                string head = new string(buf, 0, Math.Max(n, 0));
                return head.IndexOf("宝塔面板", StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch { return false; }
    }

    static bool WaitForPort(int timeoutMs)
    {
        int waited = 0;
        while (waited < timeoutMs)
        {
            if (PortInUse()) return true;
            Thread.Sleep(250);
            waited += 250;
        }
        return false;
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        base.OnFormClosed(e);
        if (_ownServer && _node != null)
        {
            try
            {
                if (!_node.HasExited)
                {
                    _node.Kill();
                    _node.WaitForExit(3000);
                }
            }
            catch { }
            try { _node.Dispose(); } catch { }
        }
    }
}