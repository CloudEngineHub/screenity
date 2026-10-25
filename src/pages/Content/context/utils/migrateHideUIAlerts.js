// "Hide UI notifications" was removed. Its mode showed the toolbar with
// everything else off, so a user who had it gets the normal UI back; a user who
// also had the toolbar hidden keeps that.
export const migrateHideUIAlerts = (stored) => {
  if (!stored?.hideUIAlerts) return null;
  const resetHideUI = !stored.hideToolbar && !stored.toolbarHover;
  return { resetHideUI };
};
