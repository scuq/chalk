//
//  chalkApp.swift
//  chalk
//
//  Created by Stefan Nistelberger on 16.11.26.
//

import SwiftUI

@main
struct chalkApp: App {
    // 136-4d: the delegate that receives the device token and the notification taps.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
