async function check(win) {
  await win.webContents.executeJavaScript(`(async () => {
    const $ = selector => document.querySelector(selector);
    const wait = async condition => {
      for (let attempt = 0; attempt < 150; attempt++) {
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error('Group picker check timed out');
    };
    const picker = $('#session-group-picker');
    const field = $('#session-group');
    const group = '开发环境';
    $('#settings-open').click();
    await wait(() => $('#settings-dialog').open);
    const background = $('#settings-background');
    try {
      for (const [color, scheme] of [['#394351', 'dark'], ['#f5f5f5', 'light']]) {
        background.value = color;
        background.dispatchEvent(new Event('input'));
        if (scheme === 'dark') $('#new').click();
        else $('.session-tools button[title="编辑"]').click();
        if (!$('#editor').open || picker.disabled) throw Error('Session group picker unavailable');
        const option = [...picker.options].find(item => item.value === group);
        const history = getComputedStyle($('#session-password-history'));
        for (const style of [getComputedStyle(picker), getComputedStyle(option)]) {
          if (style.colorScheme !== scheme || style.backgroundColor !== history.backgroundColor || style.color !== history.color)
            throw Error('Group picker colors diverge from history in ' + scheme + ' mode');
        }
        picker.value = group;
        picker.dispatchEvent(new Event('change'));
        if (field.value !== group || document.activeElement !== field) throw Error('Selecting a group did not fill its input');
        field.value = '自定义分组';
        if (new FormData($('#session-form')).get('group') !== '自定义分组') throw Error('Custom group text was lost');
        $('#editor-cancel').click();
      }
    } finally {
      if ($('#editor').open) $('#editor-cancel').click();
      $('#settings-cancel').click();
    }
  })()`);
  console.log("PASS: session group selection, custom entry and password-history colors in dark and light themes");
}

module.exports = { check };
