package com.folio.reader;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppUpdater.class);
        registerPlugin(ExternalApp.class);
        registerPlugin(IncomingFiles.class);
        super.onCreate(savedInstanceState);
    }
}
