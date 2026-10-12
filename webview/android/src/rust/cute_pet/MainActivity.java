package rust.cute_pet;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 控制台：申请悬浮窗权限、起停桌宠、以及**穿透状态下唯一的回头路**。
 *
 * 为什么需要「恢复交互」：Android 的穿透是窗口级（FLAG_NOT_TOUCHABLE），一旦置为穿透，
 * 桌宠自己收不到任何触摸，无法自救。这是 Android 与 Windows 的语义差异
 * （Windows 上 Electron 可以靠主进程轮询光标自愈），所以必须给一个壳外入口。
 */
public class MainActivity extends Activity {
    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(48, 96, 48, 48);

        TextView tip = new TextView(this);
        tip.setText("cute-pet\n\n1) 授予「显示在其他应用上层」\n2) 启动桌宠\n3) 若桌宠已穿透，点「恢复交互」");
        tip.setTextColor(Color.DKGRAY);
        box.addView(tip);

        box.addView(btn("申请悬浮窗权限", new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(MainActivity.this)) {
                    startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
                } else {
                    Toast.makeText(MainActivity.this, "已有权限", Toast.LENGTH_SHORT).show();
                }
            }
        }));
        final TextView status = new TextView(this);
        status.setTextColor(Color.DKGRAY);
        status.setText("素材：未同步");
        box.addView(status);

        box.addView(btn("下载素材包", new View.OnClickListener() {
            @Override public void onClick(View v) {
                status.setText("素材：同步中…");
                PackFetcher.sync(MainActivity.this, new PackFetcher.Log() {
                    @Override public void log(final String s) {
                        runOnUiThread(new Runnable() { @Override public void run() { status.setText("素材：" + s); } });
                    }
                }, new PackFetcher.Done() {
                    @Override public void run(final String result) {
                        runOnUiThread(new Runnable() { @Override public void run() {
                            status.setText("素材：" + result);
                            // 同步完刷新正在运行的桌宠：按 pickPack() 重新选包并 loadUrl。
                            // 之前这里只更新了 Text，服务还在用旧包，用户看不出「下载成功了」。
                            OverlayService.reloadPack();
                            Toast.makeText(MainActivity.this, "已刷新", Toast.LENGTH_SHORT).show();
                        }});
                    }
                });
            }
        }));
        box.addView(btn("刷新素材", new View.OnClickListener() {
            @Override public void onClick(View v) {
                // 桌宠运行时换包的唯一回头路（穿透状态下自己收不到触摸）。
                OverlayService.reloadPack();
                Toast.makeText(MainActivity.this, "已刷新", Toast.LENGTH_SHORT).show();
            }
        }));
        box.addView(btn("启动桌宠", new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(MainActivity.this)) {
                    Toast.makeText(MainActivity.this, "先授予悬浮窗权限", Toast.LENGTH_LONG).show();
                    return;
                }
                startService(new Intent(MainActivity.this, OverlayService.class));
                Toast.makeText(MainActivity.this, "已启动", Toast.LENGTH_SHORT).show();
            }
        }));
        box.addView(btn("恢复交互（取消穿透）", new View.OnClickListener() {
            @Override public void onClick(View v) {
                OverlayService.setPassthroughStatic(false);
                Toast.makeText(MainActivity.this, "已恢复交互", Toast.LENGTH_SHORT).show();
            }
        }));
        box.addView(btn("关闭桌宠", new View.OnClickListener() {
            @Override public void onClick(View v) {
                OverlayService.stopStatic();
                Toast.makeText(MainActivity.this, "已关闭", Toast.LENGTH_SHORT).show();
            }
        }));

        setContentView(box);
    }

    private Button btn(String text, View.OnClickListener l) {
        Button b = new Button(this);
        b.setText(text);
        b.setOnClickListener(l);
        return b;
    }
}
