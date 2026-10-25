import React, { useContext } from "react";
import styles from "../../styles/edit/_EditorNav.module.scss";
import { ContentStateContext } from "../../context/ContentState";
import DisabledTip from "../../components/global/DisabledTip";

const URL = "/assets/";

const AudioNav = () => {
  const [contentState, setContentState] = useContext(ContentStateContext);

  const handleCancel = () => {
    contentState.cancelEditOp();
    setContentState((prev) => ({
      ...prev,
      mode: "player",
      start: 0,
      end: 1,
      pendingAudio: null,
    }));
    contentState.restoreBackup();
  };

  const handleRevert = () => {
    const prevSnap = {
      blob: contentState.blob,
      start: contentState.start,
      end: contentState.end,
      pendingAudio: contentState.pendingAudio,
    };
    setContentState((prev) => ({
      ...prev,
      blob: contentState.originalBlob,
      start: 0,
      end: 1,
      pendingAudio: null,
    }));
    contentState.openToast?.(
      chrome.i18n.getMessage("sandboxToastReverted"),
      () => {
        setContentState((p) => ({ ...p, ...prevSnap }));
      },
    );
  };

  const saveBlocked = !contentState.pendingAudio && !contentState.isFfmpegRunning;

  const saveChanges = async () => {
    const { pendingAudio, volume } = contentState;
    if (!pendingAudio || contentState.isFfmpegRunning) return;

    setContentState((prev) => ({ ...prev, fromAudio: true }));

    const started = await contentState.addAudio(
      contentState.blob,
      pendingAudio,
      volume,
    );
    if (!started) {
      setContentState((prev) => ({ ...prev, fromAudio: false }));
      return;
    }

    const saved = await contentState.waitForUpdatedBlob?.();
    if (!saved) {
      setContentState((prev) => ({ ...prev, fromAudio: false }));
      return;
    }

    contentState.clearBackup();
    contentState.openToast?.(
      chrome.i18n.getMessage("sandboxToastSaved"),
      () => contentState.undo?.(),
    );
  };

  return (
    <div className={styles.editorNav}>
      <div className={styles.navWrap}>
        <div
          className={styles.editorNavLeft}
          onClick={() => chrome.runtime.sendMessage({ type: "open-home" })}
        >
          <img src={URL + "editor/logo.svg"} alt="Logo" />
        </div>

        <div className={styles.editorNavCenter}>
          <div className={styles.editorNavTitle}>
            {chrome.i18n.getMessage("sandboxEditorMainTitle")}{" "}
            <span className={styles.beta}>BETA</span>
          </div>
        </div>

        <div className={styles.editorNavRight}>
          <button
            className="button simpleButton blackButton"
            onClick={handleCancel}
          >
            {chrome.i18n.getMessage("sandboxEditorCancelButton")}
          </button>

          <button
            className="button secondaryButton"
            onClick={handleRevert}
            disabled={contentState.isFfmpegRunning}
          >
            {chrome.i18n.getMessage("sandboxEditorRevertButton")}
          </button>

          <DisabledTip
            active={saveBlocked}
            content={chrome.i18n.getMessage("sandboxEditorAudioPendingHint")}
          >
            <button
              className="button primaryButton"
              onClick={saveChanges}
              disabled={contentState.isFfmpegRunning || !contentState.pendingAudio}
            >
              {contentState.isFfmpegRunning ? (
                contentState.processingProgress > 0 ? (
                  <>
                    {chrome.i18n.getMessage("sandboxEditorSaveProgressButton") ||
                      "Saving"}{" "}
                    {Math.round(contentState.processingProgress)}%
                  </>
                ) : (
                  chrome.i18n.getMessage("sandboxEditorSaveProgressButton") ||
                  "Saving..."
                )
              ) : (
                chrome.i18n.getMessage("sandboxEditorSaveButton") ||
                "Save changes"
              )}
            </button>
          </DisabledTip>
        </div>
      </div>
    </div>
  );
};

export default AudioNav;
