package com.contractdesk.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FolderPlugin.class); // the data folder (decision-2)
        super.onCreate(savedInstanceState);
    }
}
