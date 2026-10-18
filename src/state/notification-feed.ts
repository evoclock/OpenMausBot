import type { NotificationLogEntry } from "../../shared/notification";

export const NOTIFICATION_FEED_LIMIT = 500;

export type NotificationFeedAction =
  | { type: "notificationsHydrated"; notifications: NotificationLogEntry[] }
  | { type: "notificationReceived"; entry: NotificationLogEntry }
  | { type: "notificationRead"; id: string }
  | { type: "notificationsMarkAllRead" };

/** Newest first. Hydration takes the server's copy of each entry it returns and keeps live entries it has not seen yet. */
export function reduceNotificationFeed(feed: NotificationLogEntry[], action: NotificationFeedAction): NotificationLogEntry[] {
  switch (action.type) {
    case "notificationsHydrated": {
      const served = new Set(action.notifications.map((entry) => entry.id));
      return [...feed.filter((entry) => !served.has(entry.id)), ...action.notifications]
        .sort((a, b) => b.at - a.at)
        .slice(0, NOTIFICATION_FEED_LIMIT);
    }
    case "notificationReceived":
      return feed.some((entry) => entry.id === action.entry.id) ? feed : [action.entry, ...feed].slice(0, NOTIFICATION_FEED_LIMIT);
    case "notificationRead":
      return feed.map((entry) => (entry.id === action.id && !entry.read ? { ...entry, read: true } : entry));
    case "notificationsMarkAllRead":
      return feed.map((entry) => (entry.read ? entry : { ...entry, read: true }));
  }
}
