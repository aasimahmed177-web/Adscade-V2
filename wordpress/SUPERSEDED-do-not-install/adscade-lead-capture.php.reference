<?php
/**
 * Plugin Name: Adscade Lead Capture
 * Description: Server-side storage for the /vsl-4/ qualification form. Validates,
 *              sanitises and stores submissions; exposes them in wp-admin and as CSV.
 * Version:     1.0.0
 * Author:      Adscade
 *
 * INSTALL
 *   1. Copy this file to wp-content/plugins/adscade-lead-capture/adscade-lead-capture.php
 *   2. Activate "Adscade Lead Capture" in Plugins.
 *   3. Leads appear under wp-admin → Adscade Leads.
 *
 * The landing page posts to /wp-json/adscade/v1/lead. This plugin prints the endpoint
 * and a REST nonce into the page automatically — the form stays disabled until it does,
 * so a lead is never reported as saved when it was not.
 */

if (!defined('ABSPATH')) exit;

const ADSCADE_TABLE   = 'adscade_leads';
// Deliberately generous: Indian carrier-grade NAT puts many unrelated visitors behind
// one address. This is bot friction, not a hard quota — the honeypot does the real work.
const ADSCADE_RL_MAX  = 20;   // submissions allowed per resolved client address...
const ADSCADE_RL_WIN  = 600;  // ...per this many seconds

/* ── storage ─────────────────────────────────────────────────────────── */

function adscade_table_name() {
    global $wpdb;
    return $wpdb->prefix . ADSCADE_TABLE;
}

function adscade_install() {
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $charset = $wpdb->get_charset_collate();
    $table   = adscade_table_name();

    dbDelta("CREATE TABLE {$table} (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        submission_id VARCHAR(64) NOT NULL,
        submitted_at DATETIME NOT NULL,
        name VARCHAR(191) NOT NULL,
        company VARCHAR(191) NOT NULL,
        project_name VARCHAR(191) DEFAULT '',
        project_city VARCHAR(191) NOT NULL,
        email VARCHAR(191) NOT NULL,
        phone VARCHAR(32) NOT NULL,
        consent TINYINT(1) NOT NULL DEFAULT 0,
        answers LONGTEXT,
        answer_labels LONGTEXT,
        score SMALLINT NOT NULL DEFAULT 0,
        outcome VARCHAR(32) NOT NULL,
        restriction VARCHAR(64) DEFAULT NULL,
        landing_url TEXT,
        referrer TEXT,
        utm_source VARCHAR(191) DEFAULT NULL,
        utm_medium VARCHAR(191) DEFAULT NULL,
        utm_campaign VARCHAR(191) DEFAULT NULL,
        utm_content VARCHAR(191) DEFAULT NULL,
        utm_term VARCHAR(191) DEFAULT NULL,
        gclid VARCHAR(191) DEFAULT NULL,
        viewport VARCHAR(16) DEFAULT NULL,
        calendly_shown TINYINT(1) NOT NULL DEFAULT 0,
        calendly_booked TINYINT(1) NOT NULL DEFAULT 0,
        ip_hash VARCHAR(64) DEFAULT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY submission_id (submission_id),
        KEY outcome (outcome),
        KEY submitted_at (submitted_at)
    ) {$charset};");
}
register_activation_hook(__FILE__, 'adscade_install');

/* ── endpoint config injected into the page ──────────────────────────── */

add_action('wp_footer', function () {
    if (is_admin()) return;
    printf(
        "<script>window.ADSCADE_ENDPOINT=%s;window.ADSCADE_NONCE=%s;</script>\n",
        wp_json_encode(esc_url_raw(rest_url('adscade/v1/lead'))),
        wp_json_encode(wp_create_nonce('wp_rest'))
    );
}, 5);

/* ── REST route ──────────────────────────────────────────────────────── */

add_action('rest_api_init', function () {
    register_rest_route('adscade/v1', '/lead', [
        'methods'             => 'POST',
        'callback'            => 'adscade_handle_lead',
        'permission_callback' => '__return_true', // public form; protected by nonce + honeypot + rate limit
    ]);
});

/**
 * Indian mobile carriers route very large numbers of unrelated subscribers through the
 * same public address (CGNAT). Keying a rate limit on REMOTE_ADDR alone would let one
 * carrier's pool lock out genuine visitors on a funnel that is ~99% mobile. Where a
 * trusted proxy supplies the real client address we use that; the threshold is also set
 * generously. Filter 'adscade_trusted_proxy_header' if you sit behind a CDN.
 */
function adscade_client_ip_hash() {
    $header = apply_filters('adscade_trusted_proxy_header', 'HTTP_CF_CONNECTING_IP');
    $ip = '';
    if ($header && !empty($_SERVER[$header])) {
        $ip = sanitize_text_field(wp_unslash($_SERVER[$header]));
    } elseif (!empty($_SERVER['REMOTE_ADDR'])) {
        $ip = sanitize_text_field(wp_unslash($_SERVER['REMOTE_ADDR']));
    }
    // Hashed with the site salt — we never store a raw IP.
    return $ip ? hash('sha256', $ip . wp_salt('auth')) : null;
}

function adscade_rate_limited($ip_hash) {
    if (!$ip_hash) return false;
    $key   = 'adscade_rl_' . substr($ip_hash, 0, 32);
    $count = (int) get_transient($key);
    if ($count >= ADSCADE_RL_MAX) return true;
    set_transient($key, $count + 1, ADSCADE_RL_WIN);
    return false;
}

function adscade_handle_lead(WP_REST_Request $req) {
    global $wpdb;
    $body = $req->get_json_params();
    if (!is_array($body)) {
        return new WP_Error('adscade_bad_body', 'Malformed request.', ['status' => 400]);
    }

    /* --- booking confirmation update (no new row) --- */
    if (!empty($body['submission_id']) && array_key_exists('calendly_booked', $body) && count($body) <= 2) {
        $wpdb->update(
            adscade_table_name(),
            ['calendly_booked' => 1],
            ['submission_id' => sanitize_text_field($body['submission_id'])],
            ['%d'], ['%s']
        );
        return ['ok' => true, 'updated' => true];
    }

    /* --- honeypot: real people never fill a field they cannot see --- */
    if (!empty($body['website'])) {
        return ['ok' => true, 'id' => null]; // accept silently, store nothing
    }

    $ip_hash = adscade_client_ip_hash();
    if (adscade_rate_limited($ip_hash)) {
        return new WP_Error('adscade_rate_limited', 'Too many submissions. Try again shortly.', ['status' => 429]);
    }

    /* --- required fields --- */
    $name    = sanitize_text_field($body['name']         ?? '');
    $company = sanitize_text_field($body['company']      ?? '');
    $city    = sanitize_text_field($body['project_city'] ?? '');
    $email   = sanitize_email($body['email']             ?? '');
    $phone   = sanitize_text_field($body['phone']        ?? '');
    $consent = !empty($body['consent']);

    $missing = [];
    if ($name === '')    $missing[] = 'name';
    if ($company === '') $missing[] = 'company';
    if ($city === '')    $missing[] = 'project_city';
    if (!is_email($email)) $missing[] = 'email';
    $digits = preg_replace('/\D/', '', $phone);
    if (strlen($digits) < 8 || strlen($digits) > 15) $missing[] = 'phone';
    if (!$consent) $missing[] = 'consent';

    if ($missing) {
        return new WP_Error('adscade_invalid', 'Missing or invalid: ' . implode(', ', $missing), ['status' => 422]);
    }

    /* --- outcome is recomputed here; never trust a client-supplied score --- */
    $answers = is_array($body['answers'] ?? null) ? array_map('sanitize_text_field', $body['answers']) : [];
    $scored  = adscade_score($answers);

    $attr = is_array($body['attribution'] ?? null) ? $body['attribution'] : [];
    $get  = function ($k) use ($attr) {
        return isset($attr[$k]) && $attr[$k] !== null ? sanitize_text_field($attr[$k]) : null;
    };

    $submission_id = sanitize_text_field($body['submission_id'] ?? wp_generate_uuid4());

    $ok = $wpdb->insert(adscade_table_name(), [
        'submission_id'  => $submission_id,
        'submitted_at'   => current_time('mysql'),
        'name'           => $name,
        'company'        => $company,
        'project_name'   => sanitize_text_field($body['project_name'] ?? ''),
        'project_city'   => $city,
        'email'          => $email,
        'phone'          => $phone,
        'consent'        => 1,
        'answers'        => wp_json_encode($answers),
        'answer_labels'  => wp_json_encode(is_array($body['answer_labels'] ?? null) ? $body['answer_labels'] : []),
        'score'          => $scored['score'],
        'outcome'        => $scored['outcome'],
        'restriction'    => $scored['restriction'],
        'landing_url'    => esc_url_raw($body['landing_url'] ?? ''),
        'referrer'       => esc_url_raw($body['referrer'] ?? ''),
        'utm_source'     => $get('utm_source'),
        'utm_medium'     => $get('utm_medium'),
        'utm_campaign'   => $get('utm_campaign'),
        'utm_content'    => $get('utm_content'),
        'utm_term'       => $get('utm_term'),
        'gclid'          => $get('gclid'),
        'viewport'       => sanitize_text_field($body['viewport'] ?? ''),
        'calendly_shown' => $scored['outcome'] === 'qualified' ? 1 : 0,
        'ip_hash'        => $ip_hash,
    ]);

    if ($ok === false) {
        return new WP_Error('adscade_store_failed', 'Could not store submission.', ['status' => 500]);
    }

    adscade_notify($name, $company, $city, $email, $phone, $scored);

    // The score is never returned to the browser.
    return ['ok' => true, 'submission_id' => $submission_id, 'outcome' => $scored['outcome']];
}

/* ── scoring, mirrored server-side (brief §9/§10) ────────────────────── */

function adscade_score(array $a) {
    $M = [
        'role' => ['founder'=>[20,null],'marketing_sales_lead'=>[18,null],'mandate_partner'=>[14,null],
                   'broker'=>[4,'role_broker'],'agency_other'=>[0,'role_agency']],
        'inventory' => ['100_plus'=>[20,null],'50_99'=>[18,null],'20_49'=>[14,null],
                        '1_19'=>[5,null],'none'=>[0,'no_inventory']],
        'price_band' => ['above_150'=>[10,null],'75_150'=>[10,null],'50_75'=>[8,null],
                         'below_50'=>[5,null],'mixed'=>[7,null]],
        'media_budget' => ['above_3l'=>[20,null],'1_3l'=>[18,null],'ready_1l'=>[12,null],
                           'below_1l_not_ready'=>[0,'no_budget'],'undecided'=>[4,null]],
        'followup' => ['crm'=>[20,null],'spreadsheet'=>[16,null],'inconsistent'=>[12,null],
                       'founder_only'=>[5,null],'none'=>[0,'no_followup']],
        'bottleneck' => ['low_quality'=>[10,null],'few_site_visits'=>[10,null],'no_visibility'=>[10,null],
                         'slow_followup'=>[8,null],'too_few'=>[6,null],'exploring'=>[0,null]],
    ];

    $score = 0; $restriction = null;
    foreach ($M as $key => $opts) {
        $val = $a[$key] ?? '';
        if (!isset($opts[$val])) continue;
        $score += $opts[$val][0];
        if ($opts[$val][1] && !$restriction) $restriction = $opts[$val][1];
    }

    $force_review = (($a['media_budget'] ?? '') === 'undecided');
    $team         = in_array($a['followup'] ?? '', ['crm', 'spreadsheet'], true);

    if ($restriction) {
        $outcome = 'not_current_fit';
    } elseif (($a['inventory'] ?? '') === '1_19') {
        $premium = ($a['price_band'] ?? '') === 'above_150';
        $funded  = in_array($a['media_budget'] ?? '', ['above_3l', '1_3l', 'ready_1l'], true);
        $outcome = ($premium && $funded && $team && $score >= 65 && !$force_review)
            ? 'qualified'
            : ($score >= 50 ? 'manual_review' : 'not_current_fit');
    } elseif ($force_review) {
        $outcome = $score >= 50 ? 'manual_review' : 'not_current_fit';
    } elseif ($score >= 65) {
        $outcome = 'qualified';
    } elseif ($score >= 50) {
        $outcome = 'manual_review';
    } else {
        $outcome = 'not_current_fit';
    }

    return ['score' => $score, 'outcome' => $outcome, 'restriction' => $restriction];
}

/* ── notification ────────────────────────────────────────────────────── */

function adscade_notify($name, $company, $city, $email, $phone, $scored) {
    $to      = apply_filters('adscade_notify_email', get_option('admin_email'));
    $subject = sprintf('[Adscade] %s enquiry — %s (%s)',
        ucfirst(str_replace('_', ' ', $scored['outcome'])), $company, $city);
    $lines = [
        "Outcome: {$scored['outcome']}",
        $scored['restriction'] ? "Restriction: {$scored['restriction']}" : null,
        '',
        "Name:    {$name}",
        "Company: {$company}",
        "City:    {$city}",
        "Email:   {$email}",
        "Phone:   {$phone}",
        '',
        'Full record: wp-admin → Adscade Leads',
    ];
    wp_mail($to, $subject, implode("\n", array_filter($lines, fn($l) => $l !== null)));
}

/* ── admin screen ────────────────────────────────────────────────────── */

add_action('admin_menu', function () {
    add_menu_page('Adscade Leads', 'Adscade Leads', 'manage_options',
        'adscade-leads', 'adscade_admin_page', 'dashicons-analytics', 26);
});

function adscade_admin_page() {
    global $wpdb;
    if (!current_user_can('manage_options')) wp_die('Not permitted.');

    if (isset($_GET['export']) && check_admin_referer('adscade_export')) {
        adscade_export_csv();
    }

    $rows = $wpdb->get_results('SELECT * FROM ' . adscade_table_name() . ' ORDER BY id DESC LIMIT 200');
    $url  = wp_nonce_url(admin_url('admin.php?page=adscade-leads&export=1'), 'adscade_export');

    echo '<div class="wrap"><h1>Adscade Leads</h1>';
    echo '<p><a class="button button-primary" href="' . esc_url($url) . '">Export CSV</a></p>';
    echo '<table class="widefat striped"><thead><tr>
            <th>When</th><th>Outcome</th><th>Score</th><th>Company</th><th>City</th>
            <th>Name</th><th>Email</th><th>Phone</th><th>Source</th><th>Booked</th>
          </tr></thead><tbody>';
    foreach ($rows as $r) {
        printf(
            '<tr><td>%s</td><td><strong>%s</strong>%s</td><td>%d</td><td>%s</td><td>%s</td>
                 <td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>',
            esc_html($r->submitted_at),
            esc_html($r->outcome),
            $r->restriction ? '<br><small>' . esc_html($r->restriction) . '</small>' : '',
            (int) $r->score,
            esc_html($r->company), esc_html($r->project_city), esc_html($r->name),
            esc_html($r->email), esc_html($r->phone),
            esc_html($r->utm_source ?: '—'),
            $r->calendly_booked ? 'yes' : '—'
        );
    }
    echo '</tbody></table></div>';
}

/**
 * Neutralise CSV formula injection. sanitize_text_field() strips tags but leaves a
 * leading = + - @ intact, so a value typed into "Company name" could execute when the
 * export is opened in Excel or Sheets. Prefixing with an apostrophe forces it to text.
 */
function adscade_csv_safe($v) {
    if (is_string($v) && $v !== '' && strpbrk($v[0], "=+-@\t\r") !== false) {
        return "'" . $v;
    }
    return $v;
}

function adscade_export_csv() {
    global $wpdb;
    $rows = $wpdb->get_results('SELECT * FROM ' . adscade_table_name() . ' ORDER BY id DESC', ARRAY_A);
    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename=adscade-leads-' . gmdate('Y-m-d') . '.csv');
    $out = fopen('php://output', 'w');
    if ($rows) {
        fputcsv($out, array_keys($rows[0]));
        foreach ($rows as $r) fputcsv($out, array_map('adscade_csv_safe', $r));
    }
    fclose($out);
    exit;
}
