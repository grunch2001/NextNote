package de.luisschuster.nextnote;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Passes the pen settings of the app to the S Pen handling in {@link MainActivity}. */
@CapacitorPlugin(name = "NativePen")
public class NativePenPlugin extends Plugin {

    @PluginMethod
    public void setButtonErases(PluginCall call) {
        MainActivity.penButtonErases = Boolean.TRUE.equals(call.getBoolean("enabled", true));
        call.resolve();
    }
}
