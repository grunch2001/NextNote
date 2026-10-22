package de.luisschuster.nextnote;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeHttpPlugin.class);
        registerPlugin(NativeClipboardPlugin.class);
        registerPlugin(NativeSecureStoragePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
