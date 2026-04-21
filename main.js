(function(storyContent) {
    'use strict';

    var story           = new inkjs.Story(storyContent);
    var savePoint       = "";
    var lastChoiceText  = "";
    var vocabNoticeShown = false;
    var currentSeason   = "—";
    var _prev           = { money: null, grain: null, livestock: null, health: null, reputation: null };
    var _deltaTimer     = null;
    var _pendingDeltas  = [];

    // ── GLOBAL TAGS ──────────────────────────────────
    var globalTags = story.globalTags;
    if (globalTags) {
        globalTags.forEach(function(tag) {
            var t = splitTag(tag);
            if (!t) return;
            var prop = t.key.toLowerCase();
            if (prop === 'author') {
                document.querySelectorAll('.byline, #byline-el')
                    .forEach(function(el) { el.textContent = 'by ' + t.val; });
            }
        });
    }

    var storyEl  = document.querySelector('#story');
    var scrollEl = document.querySelector('.outerContainer');
    // On mobile, #stage is the scroll container (outerContainer height = auto)
    function getScrollEl() {
      var stage = document.getElementById('stage');
      if (stage && window.innerWidth <= 640 && stage.scrollHeight > stage.clientHeight) {
        return stage;
      }
      return scrollEl;
    }

    var hasSave = loadSave();
    setupButtons(hasSave);
    savePoint = story.state.toJson();
    continueStory(true);
    syncState();
    updateHUD();

    // ── MAIN LOOP ────────────────────────────────────
    function continueStory(firstTime) {
        var prevBottom = firstTime ? 0 : bottomEdge();

        while (story.canContinue) {
            var text  = story.Continue();
            var tags  = story.currentTags;
            var cls   = [];

            // ── TAGS ──────────────────────────────────
            tags.forEach(function(tag) {
                var t = splitTag(tag);

                if (t) {
                    var key = t.key.toUpperCase().trim();

                    if (key === 'SCENE') {
                        setScene(t.val.trim().toLowerCase());
                    }
                    else if (key === 'PHASE') {
                        setPhase(t.val.trim().toLowerCase());
                    }
                    else if (key === 'CLASS') {
                        cls.push(t.val);
                    }
                    else if (key === 'BACKGROUND') {
                        scrollEl.style.backgroundImage = 'url(' + t.val + ')';
                    }
                    else if (key === 'CLEAR') {
                        removeAll('p'); removeAll('img');
                        setVisible('.header', false);
                    }
                    // JOURNAL tags have the format "JOURNAL Season Year: entry text"
                    // splitTag splits on the FIRST colon, so key = "JOURNAL Season Year"
                    else if (key.startsWith('JOURNAL')) {
                        var jSeason = key.slice('JOURNAL'.length).trim();
                        addJournalEntry(t.val.trim(), jSeason);
                    }
                }
                else if (tag.trim() === 'SHOW_DELTA') {
                    // Read ink vars RIGHT NOW and diff vs _prev — no DOM calls needed
                    try {
                        var _sd = [
                            ['money','coin'], ['grain','grain'], ['livestock','stock'],
                            ['health','health'], ['reputation','rep']
                        ];
                        var _deltas = [];
                        _sd.forEach(function(row) {
                            var cur = Number(story.variablesState.$(row[0])) || 0;
                            if (_prev[row[0]] !== null) {
                                var d = Math.round(cur - _prev[row[0]]);
                                if (d !== 0) _deltas.push({ val: d, label: row[1] });
                            }
                            _prev[row[0]] = cur;
                        });
                        if (_deltas.length) showDelta(_deltas);
                    } catch(e) {}
                }
                else if (tag.trim() === 'RESTART') {
                    restart(); return;
                }
            });

            // ── FILTER ────────────────────────────────
            if (!text.trim()) continue;

            // swallow echoed choice text
            if (lastChoiceText && text.trim() === lastChoiceText.trim()) {
                lastChoiceText = ''; continue;
            }

            // swallow character-select artifacts
            if (text.trim() === 'John' || text.trim() === 'Colette') continue;

            // vocab lines — extract terms, don't render
            if (isVocabLine(text)) {
                extractVocab(text);
                if (!vocabNoticeShown && text.includes('VOCAB')) {
                    showVocabNotice();
                    vocabNoticeShown = true;
                }
                continue;
            }

            // death detection
            checkDeath(text);

            // ── BUILD PARAGRAPH ───────────────────────
            var p = document.createElement('p');

            // Highlight numbers + unit pairs in gold
            p.innerHTML = text
                .replace(/(\d+)\s+(pennies|shillings|pence|bushels?|acres?|cows?|rabbits?)/gi, '<strong>$1 $2</strong>')
                .replace(/(\d+)%/g, '<strong>$1%</strong>');

            // Drop-cap on major section openers
            if (/^(ESSEX|The year|You stand|Your lord|There is much|You walk|Some days later|Time passes|Late summer|WINTER|MID AUTUMN|EARLY AUTUMN|LATE AUTUMN|HARVEST|RENT|LEASEHOLDER|As a leaseholder)/i.test(text)) {
                p.classList.add('section-start');
            }
            cls.forEach(function(c) { p.classList.add(c); });

            storyEl.appendChild(p);
        }

        // post-batch: sync state once (not per paragraph)
        syncState();
        if (window.updateScene) window.updateScene();
        updateHUD();

        // auto-select John if character prompt appears
        if (story.currentChoices.length > 0) {
            var first = story.currentChoices[0];
            if (first && (first.text === 'John' || first.text === 'Colette')) {
                var idx = story.currentChoices.findIndex(function(c) { return c.text === 'John'; });
                if (idx !== -1) {
                    story.ChooseChoiceIndex(idx);
                    savePoint = story.state.toJson();
                    continueStory();
                    return;
                }
            }
        }

        // ── RENDER CHOICES ────────────────────────────
        var hudChoices = document.getElementById('hud-choices');
        if (hudChoices) {
            hudChoices.innerHTML = '';
            if (!story.currentChoices.length) {
                hudChoices.innerHTML = '<span class="hud-no-choices">— reading —</span>';
            } else {
                story.currentChoices.forEach(function(choice) {
                    var clickable = !choice.tags || !choice.tags.some(function(t) {
                        return t.toUpperCase() === 'UNCLICKABLE';
                    });

                    var item = document.createElement('div');
                    var isSolo = clickable && story.currentChoices.length === 1;
                    item.className = 'hud-choice-item' + (clickable ? '' : ' disabled') +
                        (isSolo ? ' first-choice' : '');
                    item.textContent = choice.text;

                    if (clickable) {
                        item.addEventListener('click', function() {
                            hudChoices.innerHTML = '<span class="hud-no-choices">— reading —</span>';

                            lastChoiceText = choice.text;
                            story.ChooseChoiceIndex(choice.index);
                            savePoint = story.state.toJson();

                            syncState();
                            if (window.updateScene) window.updateScene();
                            updateHUD();
                            continueStory();
                        });
                    }
                    hudChoices.appendChild(item);
                });
            }
        }

        if (!firstTime) scrollDown(prevBottom);
    }

    // ── STATE SYNC ───────────────────────────────────
    // The ink file sets ~ image = "filename.webp" directly.
    // We just read that variable and forward it to sceneState.imageFile.
    // Death check remains as a safety net.
    function setScene(v) {}   // no-op: ink handles images directly
    function setPhase(v) {}   // no-op: ink handles images directly

    function syncState() {
        var s = window.sceneState;
        if (!s) return;
        try {
            var deathCheck = story.variablesState.$('death_check');
            if (deathCheck === 'dead') s.isDead = true;

            // Read the image variable set by ink (~image = "filename.webp")
            var inkImage = story.variablesState.$('image');
            if (inkImage && inkImage.trim()) {
                s.imageFile = inkImage.trim();
            }
        } catch(e) {}
    }

    // ── DEATH CHECK (from text) ───────────────────────
    function checkDeath(text) {
        if (window.sceneState.isDead) return;
        var l = text.trim().toLowerCase();
        if (l === 'dead' || l.includes('you die') || l.includes('you are dead') ||
            l.includes('starvation claims') || l.includes('you fall with it')) {
            window.sceneState.isDead = true;
        }
    }

    // ── VOCAB ────────────────────────────────────────
    var _inVocabBlock = false;

    function isVocabLine(text) {
        var t = text.trim();
        if (t.includes('VOCAB UNLOCKED') || t.includes('New Vocab Unlocked') ||
            t.includes('______________________') || t.includes('Fun fact:')) return true;
        if (/^[—–]\s*.+:\s*.+/.test(t)) return true;
        if (_inVocabBlock && /^[A-Z][^:]{2,40}:\s*.{5,}/.test(t) &&
            !t.startsWith('Land:') && !t.startsWith('Rent') && !t.startsWith('Household')) return true;
        if (_inVocabBlock && t.length > 0 && !/^[A-Z].*:/.test(t)) _inVocabBlock = false;
        return false;
    }

    function extractVocab(text) {
        var t = text.trim();
        if (t.includes('New Vocab Unlocked') || t.includes('VOCAB UNLOCKED')) _inVocabBlock = true;
        text.split('\n').forEach(function(line) {
            var l = line.trim();
            var em = l.match(/^[—–]\s*(.+?):\s*(.+)/);
            if (em) { addVocabEntry(em[1].trim(), em[2].trim()); return; }
            if (_inVocabBlock && !l.startsWith('Land:') && !l.startsWith('Rent') && !l.startsWith('Household')) {
                var pn = l.match(/^([A-Z][^:]{2,40}):\s*(.{5,})/);
                if (pn) { addVocabEntry(pn[1].trim(), pn[2].trim()); return; }
            }
            var f = l.match(/fun fact:\s*(.+)/i);
            if (f) addVocabEntry('Fun Fact', f[1].trim());
        });
    }

    function addVocabEntry(term, def) {
        var list = document.getElementById('vocab-list');
        if (!list) return;
        var placeholder = list.querySelector('.panel-placeholder');
        if (placeholder) placeholder.remove();
        var existing = list.querySelectorAll('.vocab-term');
        for (var i = 0; i < existing.length; i++) {
            if (existing[i].textContent === term) return;
        }
        var entry = document.createElement('div');
        entry.className = 'vocab-entry';
        entry.innerHTML = '<div class="vocab-term">' + term + '</div><div class="vocab-def">' + def + '</div>';
        list.appendChild(entry);
    }

    function showVocabNotice() {
        if (storyEl.querySelector('.vocab-notice')) return;
        var note = document.createElement('p');
        note.className = 'vocab-notice';
        note.innerHTML = '<strong>New vocabulary unlocked.</strong> See the Vocab tab.';
        storyEl.appendChild(note);
    }

    // ── JOURNAL ──────────────────────────────────────
    var _lastJournalSeason = null;

    function addJournalEntry(text, season) {
        var journal = document.getElementById('journal-entries');
        if (!journal) return;
        var placeholder = journal.querySelector('.panel-placeholder');
        if (placeholder) placeholder.remove();
        if (season && season !== _lastJournalSeason) {
            _lastJournalSeason = season;
            var hdr = document.createElement('div');
            hdr.className = 'journal-season-header';
            hdr.textContent = season;
            journal.appendChild(hdr);
        }
        var entry = document.createElement('div');
        entry.className = 'journal-entry';
        entry.textContent = text;
        journal.appendChild(entry);
    }

    // ── HUD ──────────────────────────────────────────
    // Flush accumulated deltas to the popup immediately
    function flushDelta() {
        if (!_pendingDeltas.length) return;
        showDelta(_pendingDeltas);
        _pendingDeltas = [];
        _inVocabBlock   = false;
    }

    function updateHUD() {
        try {
            var money      = Number(story.variablesState.$('money'))      || 0;
            var grain      = Number(story.variablesState.$('grain'))      || 0;
            var livestock  = Number(story.variablesState.$('livestock'))  || 0;
            var health     = Number(story.variablesState.$('health'))     || 100;
            var reputation = Number(story.variablesState.$('reputation')) || 100;

            // Accumulate deltas — shown only when # SHOW_DELTA tag fires in ink
            [['money', money, 'coin'], ['grain', grain, 'grain'],
             ['livestock', livestock, 'stock'], ['health', health, 'health'],
             ['reputation', reputation, 'rep']].forEach(function(row) {
                var diff = row[1] - (_prev[row[0]] === null ? row[1] : _prev[row[0]]);
                if (_prev[row[0]] !== null && Math.round(diff) !== 0) {
                    _pendingDeltas.push({ val: Math.round(diff), label: row[2] });
                }
                _prev[row[0]] = row[1];
            });
            // (no showDelta here — SHOW_DELTA tag calls flushDelta())

            setText('money-value',      money);
            setText('grain-value',      grain);
            setText('livestock-value',  livestock);
            setText('health-value',     health + '%');
            setText('reputation-value', reputation + '%');

            var status = story.variablesState.$('status') || 'villein';
            setText('status-value', status.charAt(0).toUpperCase() + status.slice(1));
            setText('season-label', currentSeason !== '—' ? currentSeason : 'Essex, 1351');

            // season overlay on image
            var overlay = document.getElementById('scene-season-overlay');
            if (overlay) overlay.textContent = currentSeason !== '—' ? currentSeason : '';
        } catch(e) {}
    }

    function setText(id, val) {
        var el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    function showDelta(deltas) {
        var el = document.getElementById('stat-delta');
        if (!el) return;
        if (_deltaTimer) clearTimeout(_deltaTimer);
        el.classList.remove('fading');
        el.innerHTML = deltas.map(function(d) {
            var cls = d.val > 0 ? 'pos' : d.val < 0 ? 'neg' : 'neu';
            return '<span class="delta-item ' + cls + '">' + (d.val > 0 ? '+' : '') + d.val + ' ' + d.label + '</span>';
        }).join('');
        el.classList.add('visible');
        _deltaTimer = setTimeout(function() {
            el.classList.add('fading');
            setTimeout(function() { el.classList.remove('visible', 'fading'); }, 700);
        }, 2400);
    }

    // ── SAVE / LOAD ───────────────────────────────────
    function loadSave() {
        try {
            var saved = localStorage.getItem('save-state');
            if (saved) { story.state.LoadJson(saved); return true; }
        } catch(e) {}
        return false;
    }

    function setupButtons(hasSave) {
        var rewind = document.getElementById('rewind');
        var save   = null;
        var reload = null;

        if (rewind) rewind.addEventListener('click', function() {
            removeAll('p'); removeAll('img');
            setVisible('.header', false);
            var hc = document.getElementById('hud-choices');
            if (hc) hc.innerHTML = '<span class="hud-no-choices">— reading —</span>';
            restart();
        });

        // Save/Load removed
    }

    function restart() {
        story.ResetState();
        setVisible('.header', true);
        vocabNoticeShown = false;
        currentSeason = '—';
        _prev = { money: null, grain: null, livestock: null, health: null, reputation: null };
        _pendingDeltas = [];
        _inVocabBlock   = false;
        _lastJournalSeason = null;

        Object.assign(window.sceneState, {
            imageFile: 'start_map.webp',
            isDead: false,
        });
        if (window.updateScene) window.updateScene();

        // Reset panels
        var journal = document.getElementById('journal-entries');
        if (journal) journal.innerHTML = '<p class="panel-placeholder">Choices recorded as you play.</p>';
        var vocab = document.getElementById('vocab-list');
        if (vocab) vocab.innerHTML = '<p class="panel-placeholder">Terms unlock as you progress.</p>';

        savePoint = story.state.toJson();
        continueStory(true);
        getScrollEl().scrollTop = 0;
    }

    // ── SCROLL ────────────────────────────────────────
    function scrollDown(prevBottom) {
        var _el = getScrollEl();
        var target = Math.min(prevBottom, _el.scrollHeight - _el.clientHeight);
        var start  = _el.scrollTop;
        var dist   = target - start;
        if (Math.abs(dist) < 4) return;
        var t0 = null;
        var dur = 1400;
        function step(t) {
            if (!t0) t0 = t;
            var p    = Math.min((t - t0) / dur, 1);
            var ease = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
            _el.scrollTop = start + dist * ease;
            if (p < 1) requestAnimationFrame(step);
        }
        requestAnimationFrame(step);
    }

    // ── UTILS ─────────────────────────────────────────
    function splitTag(tag) {
        var i = tag.indexOf(':');
        if (i === -1) return null;
        return { key: tag.slice(0, i).trim(), val: tag.slice(i + 1).trim() };
    }

    function bottomEdge() {
        var last = storyEl.lastElementChild;
        return last ? last.offsetTop + last.offsetHeight : 0;
    }

    function removeAll(sel) {
        storyEl.querySelectorAll(sel).forEach(function(el) { el.remove(); });
    }

    function setVisible(sel, v) {
        document.querySelectorAll(sel).forEach(function(el) {
            el.classList.toggle('invisible', !v);
        });
    }

})(storyContent);
